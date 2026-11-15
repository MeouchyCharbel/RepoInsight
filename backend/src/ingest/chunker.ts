import { createHash } from 'node:crypto';

/**
 * Markdown chunking per report Section 4.2:
 * - split along the heading hierarchy, never across headings; anchor = GitHub-style heading slug
 * - target <= ~800 tokens (approximated as 4 characters per token); long sections split at
 *   paragraph boundaries with ~50 tokens of overlap
 * - fenced code blocks stay whole up to a size limit
 * - every chunk records exact 1-based line ranges of the source revision, and its text is exactly
 *   those lines, so citations can be verified against the stored revision.
 */
const MAX_CHARS = 800 * 4;
const OVERLAP_CHARS = 50 * 4;
const CODE_LIMIT_CHARS = MAX_CHARS * 3;

export interface ChunkDraft {
  anchor: string;
  heading_path: string[];
  ordinal: number; // position within the source revision
  line_start: number;
  line_end: number;
  text: string;
}

interface Block {
  start: number; // 0-based line index
  end: number; // inclusive
  chars: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

export function chunkMarkdown(text: string): ChunkDraft[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections: { anchor: string; path: string[]; start: number; end: number }[] = [];
  const seen = new Map<string, number>();
  const stack: { level: number; title: string }[] = [];
  let inFence = false;
  let current = { anchor: '', path: [] as string[], start: 0, end: -1 };

  lines.forEach((line, i) => {
    if (FENCE.test(line)) inFence = !inFence;
    const m = !inFence ? HEADING.exec(line) : null;
    if (m) {
      if (current.end >= current.start) sections.push(current);
      const level = m[1]!.length;
      const title = m[2]!;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, title });
      let anchor = slugify(title) || 'section';
      const n = seen.get(anchor) ?? 0;
      seen.set(anchor, n + 1);
      if (n > 0) anchor = `${anchor}-${n}`;
      current = { anchor, path: stack.map((s) => s.title), start: i, end: i };
    } else {
      current.end = i;
    }
  });
  if (current.end >= current.start) sections.push(current);

  const out: ChunkDraft[] = [];
  for (const sec of sections) {
    for (const [start, end] of packSection(lines, blocksOf(lines, sec.start, sec.end))) {
      const body = lines.slice(start, end + 1).join('\n');
      if (!body.trim()) continue;
      out.push({ anchor: sec.anchor, heading_path: sec.path, ordinal: out.length, line_start: start + 1, line_end: end + 1, text: body });
    }
  }
  return out;
}

/** Paragraphs (separated by blank lines) and whole fenced code blocks. */
function blocksOf(lines: string[], from: number, to: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i <= to) {
    if (!lines[i]!.trim()) {
      i++;
      continue;
    }
    const start = i;
    if (FENCE.test(lines[i]!)) {
      i++;
      while (i <= to && !FENCE.test(lines[i]!)) i++;
      i = Math.min(i, to);
    } else {
      while (i + 1 <= to && lines[i + 1]!.trim() && !FENCE.test(lines[i + 1]!)) i++;
    }
    blocks.push({ start, end: i, chars: charCount(lines, start, i) });
    i++;
  }
  return blocks;
}

function charCount(lines: string[], a: number, b: number) {
  let n = 0;
  for (let i = a; i <= b; i++) n += lines[i]!.length + 1;
  return n;
}

/** Greedy packing of blocks into line ranges no larger than MAX_CHARS, with line overlap. */
function packSection(lines: string[], blocks: Block[]): [number, number][] {
  // Oversized blocks are split by lines (code blocks only beyond CODE_LIMIT_CHARS).
  const units: Block[] = [];
  for (const b of blocks) {
    const isCode = FENCE.test(lines[b.start]!);
    const limit = isCode ? CODE_LIMIT_CHARS : MAX_CHARS;
    if (b.chars <= limit) {
      units.push(b);
      continue;
    }
    let s = b.start;
    while (s <= b.end) {
      let e = s;
      while (e + 1 <= b.end && charCount(lines, s, e + 1) <= MAX_CHARS) e++;
      units.push({ start: s, end: e, chars: charCount(lines, s, e) });
      s = e + 1;
    }
  }

  const ranges: [number, number][] = [];
  let start = -1;
  let end = -1;
  for (const u of units) {
    if (start < 0) {
      start = u.start;
      end = u.end;
      continue;
    }
    if (charCount(lines, start, u.end) <= MAX_CHARS || start === u.start) {
      end = u.end;
      continue;
    }
    ranges.push([start, end]);
    // Overlap: whole trailing lines of the previous chunk, up to OVERLAP_CHARS.
    let o = end + 1;
    while (o - 1 > start && charCount(lines, o - 1, end) <= OVERLAP_CHARS) o--;
    start = o <= end && charCount(lines, o, u.end) <= MAX_CHARS ? o : u.start;
    end = u.end;
  }
  if (start >= 0) ranges.push([start, end]);
  return ranges;
}

/**
 * Deterministic configuration-key extraction (report 9.2): dotted keys and CLI flags written
 * in inline code, plus `key: value` / `key = value` lines inside fenced code.
 */
export function extractConfigKeys(text: string): string[] {
  const keys = new Set<string>();
  const KEY = /^(--[a-z][a-z0-9-]+|[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+)$/i;
  for (const m of text.matchAll(/`([^`\n]{1,120})`/g)) {
    const token = m[1]!.trim().split(/[\s:=]/)[0]!;
    if (KEY.test(token) && !/\.(md|go|ts|js|py|json|ya?ml|com|org|io)$/i.test(token)) keys.add(token.toLowerCase());
  }
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const m = inFence ? /^\s*([a-z][\w-]*(?:\.[\w-]+)+)\s*[:=]/i.exec(line) : null;
    if (m) keys.add(m[1]!.toLowerCase());
  }
  return [...keys].sort();
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** chunk_id = hash(repo_id, source_id, revision, anchor, ordinal): replays cannot duplicate chunks. */
export const chunkId = (repoId: string, sourceId: string, revision: number, anchor: string, ordinal: number) =>
  'c_' + sha256([repoId, sourceId, revision, anchor, ordinal].join('\u0000')).slice(0, 24);
