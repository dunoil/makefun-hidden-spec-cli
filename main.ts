// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// This file now also implements sections 5, 6, 7 and 8, and the `R old -> new` output line for moves (section 2).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split at its own line break (SPEC.md section 3). */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

/** One line of N: `text`, and `ctx` >= 0 when it is a context line, the index of its line in O. */
interface NLine {
  text: string;
  ctx: number;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function onlyWs(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

/** SPEC.md section 5: line equality at one tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every 0-based position at or after `from` where O occurs in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  for (const t of tiers(strict)) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Replace the O lines at `pos` with N: context lines come from the file's own matched lines, and at tier 2 every
 * other line of N is re-indented (SPEC.md section 5). */
function replaceAt(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWs(lines[pos]!);
    p = leadingWs(o[0]!);
  }
  for (const e of n) {
    if (e.ctx >= 0) out.push(lines[pos + e.ctx]!);
    else if (tier === 2 && e.text !== '' && !onlyWs(e.text) && e.text.startsWith(p)) out.push(f + e.text.slice(p.length));
    else out.push(e.text);
  }
  out.push(...lines.slice(pos + o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves performed, in order, as [old, new] pairs; the output phase turns a qualifying pair into an `R` line. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 6: unified diffs                                    */
/* ------------------------------------------------------------------ */

interface UHunk {
  /** Old start line, 1-based (A in the header). */
  a: number;
  body: string[];
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
  /** Resolved paths: null means /dev/null. */
  oldP: string | null;
  newP: string | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const DIFF_RE = /^diff --git a\/(.+) b\/(.+)$/;

/** The path of a `--- ` or `+++ ` line: text after the four characters, up to the first tab, surrounding spaces
 * removed, a leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Parse one hunk body starting after the header at `at`; returns the hunk and the index of the first line after
 * the body. */
function parseHunk(lines: string[], at: number, a: number): { hunk: UHunk; next: number } {
  let j = at + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: -1 });
    } else if (bl === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    }
    // A `\` line is not part of O or N; it only decides the final line break.
  }
  let noFinal = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const bl = body[k]!;
    if (bl.startsWith(' ') || bl.startsWith('+')) {
      noFinal = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return { hunk: { a, body, o, n, noFinal }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const blankSection = (): USection => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    delFile: false,
    hunks: [],
    oldP: null,
    newP: null,
  });
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = blankSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!.replace(/[ \t]+$/, '');
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pairOld === null && cur.pairNew === null) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = blankSection();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const r = parseHunk(lines, i, Number(m[1]));
        cur.hunks.push(r.hunk);
        inHeader = false;
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renameOld === null) cur.renameOld = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renameNew === null) cur.renameNew = line.slice(10).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.delFile = true;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i, Number(m[1]));
      cur.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i++;
  }
  for (const s of sections) {
    s.oldP = s.pairOld ?? s.renameOld ?? s.diffOld;
    s.newP = s.pairNew ?? s.renameNew ?? s.diffNew;
    if (s.oldP === '/dev/null') s.oldP = null;
    if (s.newP === '/dev/null') s.newP = null;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(before: string, hunks: UHunk[], strict: boolean, path: string): string {
  const parts = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), parts.lines.length);
      const atEnd = idx === parts.lines.length;
      const ins = h.n.map((e) => e.text);
      parts.lines.splice(idx, 0, ...ins);
      if (atEnd) parts.final = !h.noFinal;
      d += h.n.length;
      continue;
    }
    const found = findTier(parts.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsToEnd = best + h.o.length === parts.lines.length;
    parts.lines = replaceAt(parts.lines, best, h.o, h.n, found.tier);
    if (runsToEnd) parts.final = !h.noFinal;
    d += h.n.length - h.o.length;
  }
  return joinFile(parts);
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldP;
    const newP = sec.newP;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null && newP === null) return;
    const creation = oldP === null || sec.newFile;
    const deletion = !creation && (newP === null || sec.delFile);
    if (creation) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const e of h.n) if (e.ctx < 0) plus.push(e.text);
      let noFinal = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k++) if (h.body[k]!.startsWith('+')) lastPlus = k;
        if (lastPlus >= 0) {
          noFinal = lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.startsWith('\\');
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (deletion) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const op = oldP!;
      const np = newP!;
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, sec.hunks, strict, op);
      tree.moves.push([op, np]);
      tree.now.set(op, null);
      tree.now.set(np, out);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 7: SEARCH/REPLACE blocks                            */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const found = findTier(parts.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    parts.lines = replaceAt(parts.lines, found.pos[0]!, oldLines, n, found.tier);
    tree.now.set(path, joinFile(parts));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* SPEC.md section 8: V4A patches                                      */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

/** The first line at or after `from` equal to the anchor at the first tier where one is, or -1. */
function anchorIndex(lines: string[], anchor: string, from: number, strict: boolean): number {
  for (const t of tiers(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(anchor, lines[i]!, t)) return i;
    }
  }
  return -1;
}

/** The first occurrence of O at or after `from`, at the first tier with one; an end-of-file chunk takes only an
 * occurrence that ends at the file's last line. */
function occurrenceFrom(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  for (const t of tiers(strict)) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length === 0) continue;
    if (eof) {
      const q = pos.find((p) => p + o.length === lines.length);
      if (q === undefined) return null;
      return { tier: t, pos: q };
    }
    return { tier: t, pos: pos[0]! };
  }
  return null;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDelEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const idx = anchorIndex(parts.lines, ch.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? parts.lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        parts.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = occurrenceFrom(parts.lines, ch.o, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      parts.lines = replaceAt(parts.lines, found.pos, ch.o, ch.n, found.tier);
      cursor = found.pos + ch.n.length;
    }
    const out = joinFile(parts);
    if (moveTo !== null) {
      tree.moves.push([path, moveTo]);
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secNo = i + 1;
    const secLines: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      secLines.push({ text: l, no: j + 1 });
      j++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of secLines) {
        if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else if (s.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${s.no}`);
      }
      edits.push(vAddEdit(path, fileLines));
    } else if (kind === 'del') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.no}`);
      edits.push(vDelEdit(path));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice(13).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < secLines.length; k++) {
        const s = secLines[k]!;
        const t = s.text;
        if (t.startsWith('@@')) {
          const a = t.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, o: [], n: [] };
          chunks.push(cur);
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${s.no}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${s.no}`);
            cur = { anchor: null, eof: false, o: [], n: [] };
            chunks.push(cur);
          }
          if (t.startsWith(' ')) {
            const x = t.slice(1);
            cur.o.push(x);
            cur.n.push({ text: x, ctx: cur.o.length - 1 });
          } else if (t.startsWith('-')) {
            cur.o.push(t.slice(1));
          } else if (t.startsWith('+')) {
            cur.n.push({ text: t.slice(1), ctx: -1 });
          } else {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${s.no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secNo}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const kindByPath = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    kindByPath.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const suppressed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) === null || tree.original(newP) !== null) continue;
    if (tree.get(oldP) !== null || tree.get(newP) === null) continue;
    if (kindByPath.get(oldP) !== 'D' || kindByPath.get(newP) !== 'A') continue;
    suppressed.add(oldP);
    suppressed.add(newP);
    rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
  }
  for (const [p, k] of [...kindByPath.entries()].sort((a, b) => byteCmp(a[0], b[0]))) {
    if (suppressed.has(p)) continue;
    rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
