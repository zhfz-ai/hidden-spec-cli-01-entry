// mend — one patch tool for every AI edit format (SPEC.md v1).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool
// calls, finds old lines at three matching tiers, and writes every change
// or none. Node 22 standard library only: `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class EarlyExit {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class EditFail {
  readonly why: string;
  readonly at: string;
  constructor(why: string, at: string) {
    this.why = why;
    this.at = at;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function pathIsSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

interface FileShape {
  br: string;
  rows: string[];
  ends: boolean;
}

function shapeOf(text: string): FileShape {
  const at = text.indexOf('\n');
  const br = at > 0 && text[at - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, rows: [], ends: false };
  const rows = text.split(br);
  const ends = text.endsWith(br);
  if (ends) rows.pop();
  return { br, rows, ends };
}

function renderRows(rows: string[], br: string, ends: boolean): string {
  if (rows.length === 0) return '';
  return rows.join(br) + (ends ? br : '');
}

// ---- tier matching (section 5) ----

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];

function rowEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

function spotsAt(rows: string[], oldRows: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldRows.length === 0) return out;
  for (let i = Math.max(0, from); i + oldRows.length <= rows.length; i++) {
    let ok = true;
    for (let j = 0; j < oldRows.length; j++) {
      if (!rowEq(rows[i + j]!, oldRows[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tierSpots(
  rows: string[],
  oldRows: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; spots: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    let spots = spotsAt(rows, oldRows, tier, from);
    if (eofOnly) spots = spots.filter((i) => i + oldRows.length === rows.length);
    if (spots.length > 0) return { tier, spots };
  }
  return null;
}

interface NewRow {
  text: string;
  ctx: boolean;
  oldIdx: number; // index into old rows for context rows, else -1
}

function buildWritten(rows: string[], pos: number, oldRows: string[], news: NewRow[], tier: number): string[] {
  const written: string[] = [];
  const fileLead = oldRows.length > 0 ? leadOf(rows[pos]!) : '';
  const patchLead = oldRows.length > 0 ? leadOf(oldRows[0]!) : '';
  for (const n of news) {
    if (n.ctx) {
      written.push(rows[pos + n.oldIdx]!);
    } else if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(patchLead)) {
      written.push(fileLead + n.text.slice(patchLead.length));
    } else {
      written.push(n.text);
    }
  }
  return written;
}

// ---- the tree (section 10) ----

class WorkTree {
  private readonly disk = new Map<string, string | null>();
  readonly staged = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  current(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.before(p);
  }
}

type OneEdit = (tree: WorkTree, strict: boolean) => void;

function needSafe(p: string): void {
  if (!pathIsSafe(p)) throw new EditFail('unsafe', p);
}

function needFile(tree: WorkTree, p: string): string {
  needSafe(p);
  const t = tree.current(p);
  if (t === null) throw new EditFail('missing', p);
  return t;
}

// ---- format detection (section 4) ----

function sniffFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart()[0];
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const unified = lines.some(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
  return unified ? 'unified' : null;
}

// ---- JSON edits (section 9) ----

function oneJsonEdit(v: unknown): OneEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const body = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      tree.staged.set(p, body);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const prior = needFile(tree, p);
      const shape = shapeOf(prior);
      const crlf = shape.br === '\r\n';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const hay = toLf(prior);
      const needle = toLf(oldStr);
      let hits = 0;
      for (let k = hay.indexOf(needle); k >= 0; k = hay.indexOf(needle, k + 1)) hits += 1;
      if (hits === 0) throw new EditFail('no-match', p);
      if (hits > 1) throw new EditFail('ambiguous', p);
      const at = hay.indexOf(needle);
      const swapped = hay.slice(0, at) + toLf(newStr) + hay.slice(at + needle.length);
      tree.staged.set(p, crlf ? swapped.replaceAll('\n', '\r\n') : swapped);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      const prior = needFile(tree, p);
      const shape = shapeOf(prior);
      if (atLine < 0 || atLine > shape.rows.length) throw new EditFail('no-match', p);
      const rows = [...shape.rows];
      rows.splice(atLine, 0, ...added);
      tree.staged.set(p, renderRows(rows, shape.br, shape.ends));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): OneEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new EarlyExit('error: parse 1');
  const edits: OneEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new EarlyExit(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new EarlyExit(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const e = oneJsonEdit(item);
      if (e === null) throw new EarlyExit(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: OneEdit | null = null;
    try {
      e = oneJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new EarlyExit(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (section 6) ----

interface BodyRow {
  kind: 'ctx' | 'old' | 'new' | 'slash';
  text: string;
  fromBlank?: boolean;
}

interface Hunk {
  startOld: number;
  body: BodyRow[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  madeNew: boolean;
  madeGone: boolean;
  hunks: Hunk[];
}

function dashPath(raw: string): string {
  const tabAt = raw.indexOf('\t');
  const cut = (tabAt >= 0 ? raw.slice(0, tabAt) : raw).trim();
  if (cut.startsWith('a/') || cut.startsWith('b/')) return cut.slice(2);
  return cut;
}

function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new EarlyExit(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/', 2);
  if (sep < 0) throw new EarlyExit(`error: parse ${lineNo}`);
  return [rest.slice(2, sep), rest.slice(sep + 3)];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnified(lines: string[]): OneEdit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHead = false;
  let openHunk: Hunk | null = null;

  const freshSection = (): Section => ({
    gitOld: null,
    gitNew: null,
    dashOld: null,
    dashNew: null,
    renFrom: null,
    renTo: null,
    madeNew: false,
    madeGone: false,
    hunks: [],
  });

  const closeHunk = (): void => {
    if (openHunk !== null && cur !== null) {
      while (openHunk.body.length > 0) {
        const last = openHunk.body[openHunk.body.length - 1]!;
        // Trailing empty context rows (from blank patch lines) leave the body.
        if (last.kind === 'ctx' && last.text === '' && last.fromBlank === true) openHunk.body.pop();
        else break;
      }
      cur.hunks.push(openHunk);
    }
    openHunk = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const next = lines[i + 1] ?? '';

    if (line.startsWith('diff --git ')) {
      closeHunk();
      const [gx, gy] = gitPaths(line, lineNo);
      cur = freshSection();
      cur.gitOld = gx;
      cur.gitNew = gy;
      sections.push(cur);
      inHead = true;
      i += 1;
      continue;
    }

    const isPair = line.startsWith('--- ') && next.startsWith('+++ ');
    if (isPair && cur !== null && inHead && cur.dashOld === null) {
      cur.dashOld = dashPath(line.slice(4));
      cur.dashNew = dashPath(next.slice(4));
      i += 2;
      continue;
    }
    if (isPair) {
      closeHunk();
      cur = freshSection();
      cur.dashOld = dashPath(line.slice(4));
      cur.dashNew = dashPath(next.slice(4));
      sections.push(cur);
      inHead = true;
      i += 2;
      continue;
    }

    if (line.startsWith('@@')) {
      closeHunk();
      if (cur === null) throw new EarlyExit(`error: parse ${lineNo}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new EarlyExit(`error: parse ${lineNo}`);
      openHunk = { startOld: Number(m[1]), body: [] };
      inHead = false;
      i += 1;
      continue;
    }

    if (openHunk !== null) {
      if (line === '') {
        openHunk.body.push({ kind: 'ctx', text: '', fromBlank: true });
        i += 1;
        continue;
      }
      const c = line[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        const kind = c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : 'slash';
        openHunk.body.push({ kind, text: line.slice(1) });
        i += 1;
        continue;
      }
      closeHunk();
      // fall through: the line is outside the body now
    }

    if (cur !== null && inHead) {
      if (line.startsWith('--- ')) {
        // In a header, a --- line must pair with +++ (handled above).
        throw new EarlyExit(`error: parse ${lineNo + 1}`);
      }
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.madeNew = true;
      else if (line.startsWith('deleted file mode')) cur.madeGone = true;
      i += 1;
      continue;
    }

    i += 1; // prose outside bodies and headers
  }
  closeHunk();

  return sections.map((sec) => unifiedEdit(sec));
}

function sectionPaths(sec: Section): { oldP: string | null; newP: string | null } {
  if (sec.dashOld !== null || sec.dashNew !== null) return { oldP: sec.dashOld, newP: sec.dashNew };
  return { oldP: sec.renFrom ?? sec.gitOld, newP: sec.renTo ?? sec.gitNew };
}

function slashAfterLastNews(hunk: Hunk): boolean {
  let lastNews = -1;
  hunk.body.forEach((r, idx) => {
    if (r.kind === 'ctx' || r.kind === 'new') lastNews = idx;
  });
  if (lastNews < 0) return false;
  const after = hunk.body[lastNews + 1];
  return after !== undefined && after.kind === 'slash';
}

function applyHunks(
  startRows: string[],
  startEnds: boolean,
  hunks: Hunk[],
  strict: boolean,
  failPath: string,
): { rows: string[]; ends: boolean } {
  let rows = [...startRows];
  let ends = startEnds;
  let drift = 0;
  for (const hunk of hunks) {
    const oldRows: string[] = [];
    const news: NewRow[] = [];
    let oldPos = 0;
    for (const r of hunk.body) {
      if (r.kind === 'ctx') {
        oldRows.push(r.text);
        news.push({ text: r.text, ctx: true, oldIdx: oldPos });
        oldPos += 1;
      } else if (r.kind === 'old') {
        oldRows.push(r.text);
        oldPos += 1;
      } else if (r.kind === 'new') {
        news.push({ text: r.text, ctx: false, oldIdx: -1 });
      }
    }
    if (oldRows.length === 0) {
      const pos = Math.min(Math.max(hunk.startOld + drift, 0), rows.length);
      const atEnd = pos === rows.length;
      const written = news.map((n) => n.text);
      rows = [...rows.slice(0, pos), ...written, ...rows.slice(pos)];
      if (atEnd) ends = !slashAfterLastNews(hunk);
    } else {
      const found = tierSpots(rows, oldRows, strict, 0, false);
      if (found === null) throw new EditFail('no-match', failPath);
      const target = hunk.startOld - 1 + drift;
      let pos = found.spots[0]!;
      for (const s of found.spots) {
        if (Math.abs(s - target) < Math.abs(pos - target)) pos = s;
      }
      const atEnd = pos + oldRows.length === rows.length;
      const written = buildWritten(rows, pos, oldRows, news, found.tier);
      rows = [...rows.slice(0, pos), ...written, ...rows.slice(pos + oldRows.length)];
      if (atEnd) ends = !slashAfterLastNews(hunk);
    }
    drift += news.length - oldRows.length;
  }
  return { rows, ends };
}

function unifiedEdit(sec: Section): OneEdit {
  return (tree, strict) => {
    const { oldP, newP } = sectionPaths(sec);
    const isCreate = oldP === '/dev/null' || sec.madeNew;
    const isDelete = !isCreate && (newP === '/dev/null' || sec.madeGone);

    if (isCreate) {
      const p = newP ?? '';
      needSafe(p);
      if (tree.current(p) !== null) throw new EditFail('exists', p);
      const rows: string[] = [];
      let noFinal = false;
      for (const hunk of sec.hunks) {
        hunk.body.forEach((r, idx) => {
          if (r.kind === 'new') {
            rows.push(r.text);
            const after = hunk.body[idx + 1];
            noFinal = after !== undefined && after.kind === 'slash';
          }
        });
      }
      tree.staged.set(p, renderRows(rows, '\n', !noFinal));
      return;
    }

    if (isDelete) {
      const p = oldP ?? '';
      needSafe(p);
      if (tree.current(p) === null) throw new EditFail('missing', p);
      tree.staged.set(p, null);
      return;
    }

    const from = oldP ?? '';
    const to = newP ?? '';
    needSafe(from);
    needSafe(to);
    const prior = tree.current(from);
    if (prior === null) throw new EditFail('missing', from);
    const shape = shapeOf(prior);
    if (from !== to && tree.current(to) !== null) throw new EditFail('exists', to);
    const done = applyHunks(shape.rows, shape.ends, sec.hunks, strict, from);
    const text = renderRows(done.rows, shape.br, done.ends);
    if (from === to) {
      tree.staged.set(from, text);
    } else {
      tree.staged.set(to, text);
      tree.staged.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function parseSearch(lines: string[]): OneEdit[] {
  const edits: OneEdit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let midAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        midAt = j;
        break;
      }
    }
    let endAt = -1;
    if (midAt >= 0) {
      for (let j = midAt + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          endAt = j;
          break;
        }
      }
    }
    if (midAt < 0 || endAt < 0) throw new EarlyExit(`error: parse ${searchAt + 1}`);

    let blockPath: string | null = null;
    for (let j = searchAt - 1; j >= scanFrom; j--) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      blockPath = cand.trim();
      break;
    }
    if (blockPath === null) blockPath = prevPath;
    if (blockPath === null) throw new EarlyExit(`error: parse ${searchAt + 1}`);

    const oldRows = lines.slice(searchAt + 1, midAt);
    const newRows = lines.slice(midAt + 1, endAt);
    const p = blockPath;
    edits.push((tree, strict) => {
      needSafe(p);
      if (oldRows.length === 0) {
        if (tree.current(p) !== null) throw new EditFail('exists', p);
        tree.staged.set(p, renderRows(newRows, '\n', true));
        return;
      }
      const prior = tree.current(p);
      if (prior === null) throw new EditFail('missing', p);
      const shape = shapeOf(prior);
      const found = tierSpots(shape.rows, oldRows, strict, 0, false);
      if (found === null) throw new EditFail('no-match', p);
      if (found.spots.length > 1) throw new EditFail('ambiguous', p);
      const pos = found.spots[0]!;
      const news: NewRow[] = newRows.map((t) => ({ text: t, ctx: false, oldIdx: -1 }));
      const written = buildWritten(shape.rows, pos, oldRows, news, found.tier);
      const rows = [...shape.rows.slice(0, pos), ...written, ...shape.rows.slice(pos + oldRows.length)];
      tree.staged.set(p, renderRows(rows, shape.br, shape.ends));
    });

    prevPath = blockPath;
    scanFrom = endAt + 1;
    i = endAt + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface Chunk {
  anchor: string | null;
  body: BodyRow[];
  eof: boolean;
}

function parseV4a(lines: string[]): OneEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new EarlyExit('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new EarlyExit(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new EarlyExit(`error: parse ${lines.length + 1}`);

  interface RawSection {
    kind: 'add' | 'del' | 'upd';
    path: string;
    headLine: number;
    rows: Array<{ text: string; no: number }>;
  }
  const raw: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    let kind: RawSection['kind'] | null = null;
    let prefix = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      prefix = '*** Add File: ';
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      prefix = '*** Delete File: ';
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      prefix = '*** Update File: ';
    }
    if (kind !== null) {
      cur = { kind, path: line.slice(prefix.length).trim(), headLine: i + 1, rows: [] };
      raw.push(cur);
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      throw new EarlyExit(`error: parse ${i + 1}`);
    }
    cur.rows.push({ text: line, no: i + 1 });
  }
  for (const sec of raw) {
    while (sec.rows.length > 0 && isBlank(sec.rows[sec.rows.length - 1]!.text)) sec.rows.pop();
  }

  const edits: OneEdit[] = [];
  for (const sec of raw) {
    if (sec.kind === 'add') {
      const fileRows: string[] = [];
      for (const r of sec.rows) {
        if (r.text.startsWith('+')) fileRows.push(r.text.slice(1));
        else if (r.text === '') fileRows.push('');
        else throw new EarlyExit(`error: parse ${r.no}`);
      }
      const p = sec.path;
      edits.push((tree) => {
        needSafe(p);
        if (tree.current(p) !== null) throw new EditFail('exists', p);
        tree.staged.set(p, renderRows(fileRows, '\n', true));
      });
    } else if (sec.kind === 'del') {
      if (sec.rows.length > 0) throw new EarlyExit(`error: parse ${sec.rows[0]!.no}`);
      const p = sec.path;
      edits.push((tree) => {
        needSafe(p);
        if (tree.current(p) === null) throw new EditFail('missing', p);
        tree.staged.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = sec.rows;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (const r of rest) {
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchorText = t.slice(2).trim();
          open = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          chunks.push(open);
          continue;
        }
        if (t === '*** End of File') {
          if (open === null) {
            open = { anchor: null, body: [], eof: true };
            chunks.push(open);
          } else {
            open.eof = true;
          }
          open = null;
          continue;
        }
        const isBody = t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+';
        if (!isBody) throw new EarlyExit(`error: parse ${r.no}`);
        if (open === null) {
          if (chunks.length > 0) throw new EarlyExit(`error: parse ${r.no}`);
          open = { anchor: null, body: [], eof: false };
          chunks.push(open);
        }
        const kind = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
        open.body.push({ kind, text: t === '' ? '' : t.slice(1) });
      }
      if (chunks.length === 0 && moveTo === null) throw new EarlyExit(`error: parse ${sec.headLine}`);
      const p = sec.path;
      const dest = moveTo;
      edits.push((tree, strict) => {
        needSafe(p);
        if (dest !== null) needSafe(dest);
        const prior = tree.current(p);
        if (prior === null) throw new EditFail('missing', p);
        if (dest !== null && tree.current(dest) !== null) throw new EditFail('exists', dest);
        const shape = shapeOf(prior);
        let rows = [...shape.rows];
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            let hit = -1;
            const top = strict ? 0 : 2;
            for (let tier = 0; tier <= top && hit < 0; tier++) {
              for (let k = cursor; k < rows.length; k++) {
                if (rowEq(rows[k]!, chunk.anchor, tier)) {
                  hit = k;
                  break;
                }
              }
            }
            if (hit < 0) throw new EditFail('no-match', p);
            cursor = hit + 1;
          }
          const oldRows: string[] = [];
          const news: NewRow[] = [];
          let oldPos = 0;
          for (const r of chunk.body) {
            if (r.kind === 'ctx') {
              oldRows.push(r.text);
              news.push({ text: r.text, ctx: true, oldIdx: oldPos });
              oldPos += 1;
            } else if (r.kind === 'old') {
              oldRows.push(r.text);
              oldPos += 1;
            } else if (r.kind === 'new') {
              news.push({ text: r.text, ctx: false, oldIdx: -1 });
            }
          }
          if (oldRows.length === 0) {
            const pos = chunk.eof ? rows.length : Math.min(cursor, rows.length);
            const written = news.map((n) => n.text);
            rows = [...rows.slice(0, pos), ...written, ...rows.slice(pos)];
            cursor = pos + written.length;
          } else {
            const found = tierSpots(rows, oldRows, strict, cursor, chunk.eof);
            if (found === null) throw new EditFail('no-match', p);
            const pos = found.spots[0]!;
            const written = buildWritten(rows, pos, oldRows, news, found.tier);
            rows = [...rows.slice(0, pos), ...written, ...rows.slice(pos + oldRows.length)];
            cursor = pos + written.length;
          }
        }
        const text = renderRows(rows, shape.br, shape.ends);
        if (dest === null) {
          tree.staged.set(p, text);
        } else {
          tree.staged.set(dest, text);
          tree.staged.set(p, null);
          tree.moves.push([p, dest]);
        }
      });
    }
  }
  return edits;
}

// ---- invocation, output and exit codes (sections 1, 2, 10) ----

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = splitPatch(patchText);
  const kind = format === null || format === 'auto' ? sniffFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: OneEdit[];
  try {
    if (kind === 'json') edits = parseJson(patchText, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearch(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new EarlyExit('error: parse 1');
  } catch (e) {
    if (e instanceof EarlyExit) return { code: 2, out: [e.text] };
    throw e;
  }

  const tree = new WorkTree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.staged);
    const moveCount = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.staged.clear();
      for (const [k, v] of snapshot) tree.staged.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.why} ${f.at}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const movedPairs = new Map<string, string>();
  for (const [from, to] of tree.moves) {
    if (tree.before(from) !== null && tree.current(from) === null && tree.before(to) === null && tree.current(to) !== null) {
      movedPairs.set(to, from);
    }
  }
  const covered = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [to, from] of movedPairs) {
    rows.push({ key: to, text: `R ${from} -> ${to}` });
    covered.add(from);
    covered.add(to);
  }
  for (const p of tree.staged.keys()) {
    if (covered.has(p)) continue;
    const was = tree.before(p);
    const now = tree.staged.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byteCmp(x.key, y.key));

  if (!checkOnly) {
    for (const p of tree.staged.keys()) {
      const was = tree.before(p);
      const now = tree.staged.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = runCli(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
