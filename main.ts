// mend: one patch tool for every AI edit format.
//
// Applies a single patch, written as a unified diff, SEARCH/REPLACE
// blocks, a V4A patch, or JSON editor calls, to the tree in the working
// directory. Implements SPEC.md version 1 in full: the command line, the
// output and exit codes, safe paths, format detection, three-tier line
// matching, all four readers, and all-or-nothing writes. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// A trial hands over to runner.ts when MAKEFUN_ENV_URL is set: keep the
// hand-over at the bottom and runner.ts as the kit ships it.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type FormatName = (typeof FORMAT_NAMES)[number];

// A parse fault: the single exit-2 line it produces.
class ParseFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

// One failed edit: its code and the path the failure concerns.
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

// A patch's lines: split at \n, one trailing \r removed from each, and
// the empty piece after a final \n dropped.
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const out = text.split('\n');
  if (text.endsWith('\n')) out.pop();
  return out.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC section 3)
// ---------------------------------------------------------------------------

interface FileView {
  br: '\n' | '\r\n';
  lines: string[];
  finalBreak: boolean;
}

function readView(text: string): FileView {
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

// A file of no lines is written empty; otherwise its lines joined with
// its break, plus a final break exactly when finalBreak says so.
function writeView(lines: string[], finalBreak: boolean, br: '\n' | '\r\n'): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it
// ---------------------------------------------------------------------------

class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
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

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// ---------------------------------------------------------------------------
// Three-tier line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  const noTrail = s.replace(/[ \t]+$/, '');
  if (tier === 1) return noTrail;
  return noTrail.replace(/^[ \t]+/, '');
}

function occurrencesAt(file: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0 || oldLines.length > file.length) return out;
  const want = oldLines.map((l) => normLine(l, tier));
  for (let i = 0; i + oldLines.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (normLine(file[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier at which oldLines occur at least once, with its positions.
function firstTier(file: string[], oldLines: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrencesAt(file, oldLines, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// One line of N. ctx >= 0 means it is a context line: it is the file's own
// matched line, the ctx-th line of O. ctx === -1 means a fresh line.
interface NewLine {
  text: string;
  ctx: number;
}

// Build N's replacement lines: context lines from the file, other lines
// re-indented at tier 2 from O's first line to the file's first matched
// line, written as they are at tiers 0 and 1.
function buildNew(nLines: NewLine[], oLines: string[], file: string[], pos: number, tier: number): string[] {
  const f = leadingWs(file[pos] ?? '');
  const p = leadingWs(oLines[0] ?? '');
  return nLines.map((nl) => {
    if (nl.ctx >= 0) return file[pos + nl.ctx]!;
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

type Edit = (tree: Tree) => void;

interface MendContext {
  strict: boolean;
  moves: { old: string; new: string }[];
}

function failUnlessSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFault('unsafe', p);
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): FormatName | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const load = (tree: Tree): string => {
    failUnlessSafe(p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      failUnlessSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
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
      const before = load(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = load(tree);
      const view = readView(before);
      if (line < 0 || line > view.lines.length) throw new EditFault('no-match', p);
      const lines = view.lines.slice();
      lines.splice(line, 0, ...add);
      tree.now.set(p, writeView(lines, view.finalBreak, view.br));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    for (const item of v) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  start: number; // A, the 1-based old start line
  body: string[];
  lineNo: number;
}

interface UnifiedSection {
  oldPath: string | null | undefined; // null: /dev/null, undefined: unnamed
  newPath: string | null | undefined;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

// The path after `--- ` / `+++ `: text after four characters, up to the
// first tab, surrounding spaces removed, a leading a/ or b/ removed.
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[], ctx: MendContext): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let hasHunk = false;
  let i = 0;
  const startSection = (s: UnifiedSection): void => {
    sections.push(s);
    cur = s;
    hasHunk = false;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      startSection({ oldPath: m[1], newPath: m[2], creation: false, deletion: false, hunks: [] });
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && !hasHunk) {
        cur.oldPath = oldP;
        cur.newPath = newP;
      } else {
        startSection({ oldPath: oldP, newPath: newP, creation: false, deletion: false, hunks: [] });
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !hasHunk) throw new ParseFault(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          body.push(l);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ start: Number(m[1]), body, lineNo: i + 1 });
      hasHunk = true;
      i = j;
      continue;
    }
    if (cur !== null && !hasHunk) {
      if (line.startsWith('rename from ')) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((s) => unifiedEdit(s, ctx));
}

// Split a hunk body into its old lines, its new lines (with context
// flags), and whether a `\` line follows its last context or `+` line.
function splitHunk(body: string[]): { o: string[]; n: NewLine[]; backslash: boolean } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: -1 });
    } else if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    }
  }
  let backslash = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.startsWith(' ') || body[k]!.startsWith('+')) {
      backslash = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return { o, n, backslash };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const view = readView(text);
  let lines = view.lines.slice();
  let finalBreak = view.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n, backslash } = splitHunk(h.body);
    if (o.length === 0) {
      const at = Math.min(h.start + d, lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...n.map((x) => x.text));
      if (atEnd) finalBreak = !backslash;
    } else {
      const found = firstTier(lines, o, strict);
      if (found === null) throw new EditFault('no-match', path);
      const target = h.start - 1 + d;
      let best = found.at[0]!;
      for (const pos of found.at) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const runsToEnd = best + o.length === lines.length;
      const built = buildNew(n, o, lines, best, found.tier);
      lines.splice(best, o.length, ...built);
      if (runsToEnd) finalBreak = !backslash;
    }
    d += n.length - o.length;
  }
  return writeView(lines, finalBreak, view.br);
}

function unifiedEdit(s: UnifiedSection, ctx: MendContext): Edit {
  const oldP = s.oldPath === undefined ? s.newPath : s.oldPath;
  const newP = s.newPath === undefined ? s.oldPath : s.newPath;
  const isCreation = s.oldPath === null || s.creation;
  const isDeletion = !isCreation && (s.newPath === null || s.deletion);
  const isMove = !isCreation && !isDeletion && oldP !== undefined && newP !== undefined && oldP !== null && newP !== null && oldP !== newP;
  if (isCreation) {
    const p = newP!;
    return (tree) => {
      failUnlessSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const l of h.body) if (l.startsWith('+')) plus.push(l.slice(1));
      // Only the last `+` line of the whole section decides the break.
      let finalBreak = plus.length > 0;
      let decided = false;
      for (let hi = s.hunks.length - 1; hi >= 0 && !decided; hi -= 1) {
        const h = s.hunks[hi]!;
        for (let k = h.body.length - 1; k >= 0; k -= 1) {
          if (h.body[k]!.startsWith('+')) {
            finalBreak = !(k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\'));
            decided = true;
            break;
          }
        }
      }
      tree.now.set(p, writeView(plus, finalBreak, '\n'));
    };
  }
  if (isDeletion) {
    const p = oldP!;
    return (tree) => {
      failUnlessSafe(p);
      if (tree.get(p) === null) throw new EditFault('missing', p);
      tree.now.set(p, null);
    };
  }
  if (isMove) {
    const from = oldP as string;
    const to = newP as string;
    return (tree) => {
      failUnlessSafe(from);
      failUnlessSafe(to);
      if (tree.get(from) === null) throw new EditFault('missing', from);
      if (tree.get(to) !== null) throw new EditFault('exists', to);
      const out = applyHunks(tree.get(from)!, s.hunks, ctx.strict, from);
      tree.now.set(from, null);
      tree.now.set(to, out);
      ctx.moves.push({ old: from, new: to });
    };
  }
  const p = (oldP ?? newP)!;
  return (tree) => {
    failUnlessSafe(p);
    if (tree.get(p) === null) throw new EditFault('missing', p);
    tree.now.set(p, applyHunks(tree.get(p)!, s.hunks, ctx.strict, p));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], ctx: MendContext): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's >>>>>>> line
  let prevPath: string | null = null;
  for (let s = 0; s < lines.length; s += 1) {
    if (lines[s]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let e = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        e = k;
        break;
      }
    }
    let r = -1;
    if (e >= 0) {
      for (let k = e + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          r = k;
          break;
        }
      }
    }
    if (e < 0 || r < 0) throw new ParseFault(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, e);
    const newLines = lines.slice(e + 1, r);
    edits.push(searchReplaceEdit(path, oldLines, newLines, ctx));
    prevEnd = r;
    prevPath = path;
  }
  if (edits.length === 0) throw new ParseFault('error: parse 1');
  return edits;
}

function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], ctx: MendContext): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      failUnlessSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, writeView(newLines, true, '\n'));
    };
  }
  return (tree) => {
    failUnlessSafe(p);
    const before = tree.get(p);
    if (before === null) throw new EditFault('missing', p);
    const view = readView(before);
    const found = firstTier(view.lines, oldLines, ctx.strict);
    if (found === null) throw new EditFault('no-match', p);
    if (found.at.length > 1) throw new EditFault('ambiguous', p);
    const pos = found.at[0]!;
    const built = buildNew(
      newLines.map((t) => ({ text: t, ctx: -1 })),
      oldLines,
      view.lines,
      pos,
      found.tier,
    );
    const lines = view.lines.slice();
    lines.splice(pos, oldLines.length, ...built);
    tree.now.set(p, writeView(lines, view.finalBreak, view.br));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null; // null: no anchor (empty text counts as none)
  eof: boolean;
  body: { kind: 'ctx' | 'old' | 'new'; text: string }[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo?: string;
  lines?: string[];
  chunks?: V4aChunk[];
  lineNo: number;
}

const SECTION_START = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], ctx: MendContext): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  const last = lines.map((l, i) => (isBlank(l) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i]!)) i += 1;
    if (i >= last) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const collected: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (SECTION_START(l)) break;
        if (l.startsWith('+')) {
          collected.push(l.slice(1));
          j += 1;
        } else if (l === '') {
          collected.push('');
          j += 1;
        } else if (isBlank(l)) {
          j += 1;
        } else {
          throw new ParseFault(`error: parse ${j + 1}`);
        }
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      sections.push({ kind: 'add', path, lines: collected, lineNo: i + 1 });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && isBlank(lines[j]!)) j += 1;
      if (j < last && !SECTION_START(lines[j]!)) throw new ParseFault(`error: parse ${j + 1}`);
      sections.push({ kind: 'delete', path, lineNo: i + 1 });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      let moveTo: string | undefined;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      const nextNonBlank = (from: number): number => {
        let k = from;
        while (k < last && isBlank(lines[k]!)) k += 1;
        return k;
      };
      while (j < last) {
        const l = lines[j]!;
        if (SECTION_START(l)) break;
        if (l === '') {
          const k = nextNonBlank(j);
          if (k >= last || SECTION_START(lines[k]!)) break;
          if (curChunk === null && chunks.length > 0) throw new ParseFault(`error: parse ${j + 1}`);
          if (curChunk === null) {
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
          }
          curChunk.body.push({ kind: 'ctx', text: '' });
          j += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
          chunks.push(curChunk);
          j += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new ParseFault(`error: parse ${j + 1}`);
          curChunk.eof = true;
          curChunk = null;
          j += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length > 0) throw new ParseFault(`error: parse ${j + 1}`);
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
          }
          const kind = l.startsWith(' ') ? 'ctx' : l.startsWith('-') ? 'old' : 'new';
          curChunk.body.push({ kind, text: l.slice(1) });
          j += 1;
          continue;
        }
        throw new ParseFault(`error: parse ${j + 1}`);
      }
      if (chunks.length > 0) {
        const tail = chunks[chunks.length - 1]!;
        while (tail.body.length > 0) {
          const b = tail.body[tail.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') tail.body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new ParseFault(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks, lineNo: i + 1 });
      i = j;
      continue;
    }
    throw new ParseFault(`error: parse ${i + 1}`);
  }
  if (sections.length === 0) throw new ParseFault('error: parse 1');
  return sections.map((s) => v4aEdit(s, ctx));
}

function v4aEdit(s: V4aSection, ctx: MendContext): Edit {
  if (s.kind === 'add') {
    const p = s.path;
    const content = writeView(s.lines ?? [], true, '\n');
    return (tree) => {
      failUnlessSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, content);
    };
  }
  if (s.kind === 'delete') {
    const p = s.path;
    return (tree) => {
      failUnlessSafe(p);
      if (tree.get(p) === null) throw new EditFault('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = s.path;
  const to = s.moveTo;
  return (tree) => {
    failUnlessSafe(p);
    if (to !== undefined) failUnlessSafe(to);
    const before = tree.get(p);
    if (before === null) throw new EditFault('missing', p);
    if (to !== undefined && tree.get(to) !== null) throw new EditFault('exists', to);
    const out = applyV4aChunks(before, s.chunks ?? [], p, ctx.strict);
    tree.now.set(p, to === undefined ? out : null);
    if (to !== undefined) {
      tree.now.set(to, out);
      ctx.moves.push({ old: p, new: to });
    }
  };
}

function applyV4aChunks(text: string, chunks: V4aChunk[], path: string, strict: boolean): string {
  const view = readView(text);
  const lines = view.lines.slice();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      let foundAt = -1;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        for (let k = cursor; k < lines.length; k += 1) {
          if (normLine(lines[k]!, tier) === normLine(chunk.anchor!, tier)) {
            foundAt = k;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new EditFault('no-match', path);
      cursor = foundAt + 1;
    }
    const o: string[] = [];
    const n: NewLine[] = [];
    for (const b of chunk.body) {
      if (b.kind === 'ctx') {
        o.push(b.text);
        n.push({ text: b.text, ctx: o.length - 1 });
      } else if (b.kind === 'old') {
        o.push(b.text);
      } else {
        n.push({ text: b.text, ctx: -1 });
      }
    }
    if (o.length === 0) {
      const at = chunk.eof ? lines.length : cursor;
      lines.splice(at, 0, ...n.map((x) => x.text));
      cursor = at + n.length;
      continue;
    }
    let pos = -1;
    let tierUsed = 0;
    for (const tier of strict ? [0] : [0, 1, 2]) {
      const at = occurrencesAt(lines, o, tier).filter((q) => q >= cursor && (!chunk.eof || q + o.length === lines.length));
      if (at.length > 0) {
        pos = at[0]!;
        tierUsed = tier;
        break;
      }
    }
    if (pos < 0) throw new EditFault('no-match', path);
    const built = buildNew(n, o, lines, pos, tierUsed);
    lines.splice(pos, o.length, ...built);
    cursor = pos + built.length;
  }
  return writeView(lines, view.finalBreak, view.br);
}

// ---------------------------------------------------------------------------
// Running one invocation (SPEC sections 1, 2, 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: FormatName | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (FORMAT_NAMES as readonly string[]).includes(a.slice(9))) {
        format = a.slice(9) as FormatName;
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: MendContext = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, ctx);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, ctx);
    else edits = parseV4a(lines, ctx);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // Change rows, byte-ordered by path (by <new> for moves). A move whose
  // old path existed before the patch and is gone after it, and whose new
  // path did not exist before and does after it, is one R line instead of
  // its D and A lines.
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of ctx.moves) {
    if (
      tree.original(m.old) !== null &&
      tree.original(m.new) === null &&
      tree.get(m.old) === null &&
      tree.get(m.new) !== null
    ) {
      covered.add(m.old);
      covered.add(m.new);
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
    }
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    if (covered.has(p)) {
      // A move's files are still written; only its rows are replaced.
      const now = tree.now.get(p)!;
      if (!check) {
        if (now === null) rmSync(p, { force: true });
        else {
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, now);
        }
      }
      continue;
    }
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
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
