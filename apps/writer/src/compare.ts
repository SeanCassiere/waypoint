// Revision compare (spec §10 B1). Pure functions of two manifests and blob text, so results
// are cached by content hash. Uses jsdiff for block LCS, word diffs, and line diffs.
import { isMarkdown, isTextMime, type Manifest } from "@waypoint/core";
import { diffArrays, diffLines, diffWordsWithSpace } from "diff";

export type FileStatus = "added" | "removed" | "modified" | "unchanged";
export interface CompareFile {
  path: string;
  status: FileStatus;
  mime: string;
  base: { hash: string; size: number } | null;
  head: { hash: string; size: number } | null;
  text: boolean;
}
export interface ManifestCompare {
  head_path_changed: boolean;
  counts: Record<FileStatus, number>;
  files: CompareFile[];
}

/** Files in head order (head file first, then by path); removed files keep their path position. */
export function compareManifests(base: Manifest | null, head: Manifest): ManifestCompare {
  const counts: Record<FileStatus, number> = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const paths = new Set([...Object.keys(head.files), ...Object.keys(base?.files ?? {})]);
  const files: CompareFile[] = [];
  for (const path of paths) {
    const now = head.files[path];
    const before = base?.files[path];
    const status: FileStatus = !before
      ? "added"
      : !now
        ? "removed"
        : before.hash === now.hash
          ? "unchanged"
          : "modified";
    counts[status]++;
    const mime = (now ?? before)?.mime ?? "application/octet-stream";
    files.push({
      path,
      status,
      mime,
      base: before ? { hash: before.hash, size: before.size } : null,
      head: now ? { hash: now.hash, size: now.size } : null,
      text: isTextMime(mime),
    });
  }
  files.sort((a, b) =>
    a.path === head.headPath
      ? -1
      : b.path === head.headPath
        ? 1
        : a.path < b.path
          ? -1
          : a.path > b.path
            ? 1
            : 0,
  );
  return { head_path_changed: Boolean(base && base.headPath !== head.headPath), counts, files };
}

export type BlockKind = "heading" | "paragraph" | "list-item" | "table" | "code" | "other";
export interface Block {
  kind: BlockKind;
  text: string;
}
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const TABLE = /^ {0,3}\|/;
const QUOTE = /^ {0,3}>/;
const RULE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

/** Splits Markdown into diffable blocks: fences whole, list items and table rows separately. */
export function splitBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let current: Block | null = null;
  // A getter, so control-flow narrowing doesn't assume flush() left `current` unchanged.
  const peek = (): Block | null => current;
  const flush = () => {
    if (current) blocks.push({ kind: current.kind, text: current.text.replace(/\n+$/, "") });
    current = null;
  };
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      blocks.push({ kind: "other", text: lines.slice(0, end + 1).join("\n") });
      index = end + 1;
    }
  }
  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? "```";
      const body = [line];
      for (index++; index < lines.length; index++) {
        const next = lines[index] ?? "";
        body.push(next);
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(next);
        if (close && close[1]?.[0] === marker[0] && (close[1]?.length ?? 0) >= marker.length) break;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (HEADING.test(line) || RULE.test(line)) {
      flush();
      blocks.push({ kind: HEADING.test(line) ? "heading" : "other", text: line });
      continue;
    }
    if (TABLE.test(line)) {
      flush();
      blocks.push({ kind: "table", text: line });
      continue;
    }
    if (LIST.test(line)) {
      flush();
      current = { kind: "list-item", text: line };
      continue;
    }
    const isQuote = QUOTE.test(line);
    const open = peek();
    const currentKind: BlockKind | undefined = open?.kind;
    if (currentKind && (currentKind === "list-item" || (currentKind === "other") === isQuote)) {
      if (open) open.text += `\n${line}`;
      continue;
    }
    flush();
    current = { kind: isQuote ? "other" : "paragraph", text: line };
  }
  flush();
  return blocks;
}

export type WordOp = { op: "equal" | "insert" | "delete"; text: string };
export interface DiffBlock {
  op: "equal" | "insert" | "delete" | "replace";
  kind: BlockKind;
  base_text?: string;
  head_text?: string;
  words?: WordOp[];
}
export interface Hunk {
  base_start: number;
  head_start: number;
  folded_before: number;
  blocks: DiffBlock[];
}
export interface LineDiffRow {
  op: "equal" | "insert" | "delete" | "hunk";
  base?: number;
  head?: number;
  text: string;
  words?: WordOp[];
}
export interface FileDiff {
  path: string;
  status: FileStatus;
  kind: "text" | "image" | "binary";
  truncated: boolean;
  /** Every block in order (the page folds unchanged runs itself). */
  ops: DiffBlock[];
  /** Hunks with one block of context; folded runs are counted, not included (API shape). */
  hunks: Hunk[];
  folded_after: number;
  lines?: LineDiffRow[];
}
export const MAX_SIDE_BYTES = 1024 * 1024;
export const MAX_BLOCKS = 5000;

function words(base: string, head: string): WordOp[] {
  return diffWordsWithSpace(base, head).map((part) => ({
    op: part.added ? "insert" : part.removed ? "delete" : "equal",
    text: part.value,
  }));
}

const wordSet = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** Jaccard overlap of word sets: 0 (unrelated) to 1 (same words). */
function similarity(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

function unpack(value: string): Block {
  const at = value.indexOf("\u0000");
  const kind = value.slice(0, at);
  const known: BlockKind[] = ["heading", "paragraph", "list-item", "table", "code", "other"];
  return { kind: known.find((item) => item === kind) ?? "other", text: value.slice(at + 1) };
}

/** LCS over blocks; adjacent delete+insert runs of the same kind pair into replacements. */
export function diffBlocks(base: Block[], head: Block[]): DiffBlock[] {
  const changes = diffArrays(
    base.map((block) => `${block.kind}\u0000${block.text}`),
    head.map((block) => `${block.kind}\u0000${block.text}`),
  );
  const ops: DiffBlock[] = [];
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]!;
    if (!change.added && !change.removed) {
      for (const value of change.value) {
        const block = unpack(value);
        ops.push({ op: "equal", kind: block.kind, base_text: block.text, head_text: block.text });
      }
      continue;
    }
    const removed = change.removed ? change.value.map(unpack) : [];
    const next = changes[index + 1];
    const added =
      change.removed && next?.added
        ? next.value.map(unpack)
        : change.added
          ? change.value.map(unpack)
          : [];
    if (change.removed && next?.added) index++;
    const pending = [...added];
    for (const before of removed) {
      // Pair with the most similar insertion of the same kind; unrelated blocks stay separate.
      let match = -1;
      let best = 0.25;
      pending.forEach((after, at) => {
        if (after.kind !== before.kind) return;
        const score = similarity(before.text, after.text);
        if (score > best) {
          best = score;
          match = at;
        }
      });
      if (match >= 0) {
        for (const extra of pending.splice(0, match))
          ops.push({ op: "insert", kind: extra.kind, head_text: extra.text });
        const after = pending.shift()!;
        ops.push({
          op: "replace",
          kind: before.kind,
          base_text: before.text,
          head_text: after.text,
          words: words(before.text, after.text),
        });
      } else ops.push({ op: "delete", kind: before.kind, base_text: before.text });
    }
    for (const after of pending)
      ops.push({ op: "insert", kind: after.kind, head_text: after.text });
  }
  return ops;
}

/** Groups ops into hunks with one block of context around each change. */
export function toHunks(ops: DiffBlock[]): { hunks: Hunk[]; folded_after: number } {
  const hunks: Hunk[] = [];
  let baseLine = 0;
  let headLine = 0;
  let folded = 0;
  let current: Hunk | null = null;
  const changedAt = ops.map((op) => op.op !== "equal");
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index]!;
    const near = changedAt[index] || changedAt[index - 1] || changedAt[index + 1];
    if (near) {
      if (!current) {
        current = { base_start: baseLine, head_start: headLine, folded_before: folded, blocks: [] };
        hunks.push(current);
        folded = 0;
      }
      current.blocks.push(op);
    } else {
      current = null;
      folded++;
    }
    if (op.op !== "insert") baseLine++;
    if (op.op !== "delete") headLine++;
  }
  return { hunks, folded_after: folded };
}

const splitLines = (value: string) => value.replace(/\n$/, "").split("\n");

/** A unified line diff with word highlights inside changed line pairs. */
export function diffTextLines(base: string, head: string, context = 3): LineDiffRow[] {
  const rows: LineDiffRow[] = [];
  let baseLine = 1;
  let headLine = 1;
  const parts = diffLines(base, head);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!part.added && !part.removed) {
      for (const text of splitLines(part.value))
        rows.push({ op: "equal", base: baseLine++, head: headLine++, text });
      continue;
    }
    const removed = part.removed ? splitLines(part.value) : [];
    const next = parts[index + 1];
    const added =
      part.removed && next?.added
        ? splitLines(next.value)
        : part.added
          ? splitLines(part.value)
          : [];
    if (part.removed && next?.added) index++;
    removed.forEach((text, at) => {
      const pair = added[at];
      rows.push({
        op: "delete",
        base: baseLine++,
        text,
        ...(pair !== undefined
          ? { words: words(text, pair).filter((word) => word.op !== "insert") }
          : {}),
      });
    });
    added.forEach((text, at) => {
      const pair = removed[at];
      rows.push({
        op: "insert",
        head: headLine++,
        text,
        ...(pair !== undefined
          ? { words: words(pair, text).filter((word) => word.op !== "delete") }
          : {}),
      });
    });
  }
  // Fold long unchanged stretches into hunk separators.
  const keep = rows.map(
    (row, index) =>
      row.op !== "equal" ||
      rows
        .slice(Math.max(0, index - context), index + context + 1)
        .some((near) => near.op !== "equal"),
  );
  const out: LineDiffRow[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (skipped)
        out.push({ op: "hunk", text: `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}` });
      skipped = 0;
      out.push(row);
    } else skipped++;
  });
  if (skipped && out.length)
    out.push({ op: "hunk", text: `${skipped} unchanged ${skipped === 1 ? "line" : "lines"}` });
  return out;
}

export function fileKind(mime: string): "text" | "image" | "binary" {
  return isTextMime(mime) ? "text" : mime.startsWith("image/") ? "image" : "binary";
}

/** Diffs one file. `null` text means the side doesn't exist; `undefined` means it's too large. */
export function diffFile(
  file: CompareFile,
  baseText: string | null | undefined,
  headText: string | null | undefined,
  mode: "blocks" | "lines",
): FileDiff {
  const kind = fileKind(file.mime);
  const empty = { ops: [], hunks: [], folded_after: 0 };
  if (kind !== "text")
    return { path: file.path, status: file.status, kind, truncated: false, ...empty };
  if (baseText === undefined || headText === undefined)
    return { path: file.path, status: file.status, kind, truncated: true, ...empty };
  const before = baseText ?? "";
  const after = headText ?? "";
  if (mode === "lines" || !isMarkdown(file.mime))
    return {
      path: file.path,
      status: file.status,
      kind,
      truncated: false,
      ...empty,
      lines: diffTextLines(before, after),
    };
  const baseBlocks = splitBlocks(before);
  const headBlocks = splitBlocks(after);
  if (baseBlocks.length > MAX_BLOCKS || headBlocks.length > MAX_BLOCKS)
    return { path: file.path, status: file.status, kind, truncated: true, ...empty };
  const ops = diffBlocks(file.base ? baseBlocks : [], file.head ? headBlocks : []);
  return { path: file.path, status: file.status, kind, truncated: false, ops, ...toHunks(ops) };
}

/** A small LRU keyed by (base hash, head hash, mode); results are pure functions of content. */
export class DiffCache {
  private readonly entries = new Map<string, FileDiff>();
  constructor(private readonly max = 200) {}
  get(key: string): FileDiff | undefined {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: FileDiff): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max)
      this.entries.delete(this.entries.keys().next().value ?? "");
  }
}
