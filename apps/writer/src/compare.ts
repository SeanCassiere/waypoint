// Revision compare (spec §10 B1). Pure functions of two manifests and blob text, so results
// are cached by content hash. Uses jsdiff for block LCS, word diffs, and line diffs.
//
// Diffing is superlinear, and the Changes page is a plain GET, so every jsdiff call has an edit
// length cap and a time budget, word diffs and similarity pairing are bounded, and large inputs
// are diffed in a worker thread (compare-worker.ts) that is terminated if it overruns. A diff
// that hits a limit is `truncated` with a reason.
import { Worker } from "node:worker_threads";

import { isMarkdown, isTextMime, type Manifest } from "@waypoint/core";
import { diffArrays, diffLines, diffWordsWithSpace } from "diff";

import { workerEntry } from "./layout.ts";

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
/** Why a diff wasn't computed: a side over 1 MB, too many lines or blocks, or too costly. */
export type TruncatedReason = "size" | "lines" | "blocks" | "complex";
export interface FileDiff {
  path: string;
  status: FileStatus;
  kind: "text" | "image" | "binary";
  truncated: boolean;
  /** Set when `truncated` is true. */
  truncated_reason?: TruncatedReason;
  /** Every block in order (the page folds unchanged runs itself). */
  ops: DiffBlock[];
  /** Hunks with one block of context; folded runs are counted, not included (API shape). */
  hunks: Hunk[];
  folded_after: number;
  lines?: LineDiffRow[];
}
export const MAX_SIDE_BYTES = 1024 * 1024;
export const MAX_BLOCKS = 5000;
/** Line diffs (`lines` mode and non-Markdown text) stop at this many lines per side. */
export const MAX_LINES = 20_000;
/** Word diffs run only when both sides are at most this long (UTF-16 units); larger pairs show
 * as a plain delete and insert. */
export const MAX_WORD_DIFF = 16 * 1024;
/** Word diffs in one file stop after this much input in total. */
export const WORD_DIFF_BUDGET = 512 * 1024;
/** Similarity pairing compares at most this many removed × added blocks per change run. */
export const MAX_PAIRINGS = 250_000;
/**
 * Myers edit-length caps. Cost grows with the square of the edit length when the sides differ
 * throughout, but stays linear for appends and local edits, so the line and block cap is
 * generous and the time budget does most of the bounding. Word highlights with more than a few
 * hundred edits aren't worth showing.
 */
const MAX_EDIT_LENGTH = 10_000;
const MAX_WORD_EDIT_LENGTH = 500;
/** Wall-clock budget for the jsdiff calls of one file diff. */
export const DIFF_TIME_BUDGET_MS = 1000;

class TooComplex extends Error {}

/**
 * One file diff's shared limits: a deadline, and the word-diff input and time left. Word
 * highlights may use half the time; once that's spent, the rest of the file has none.
 */
export class DiffBudget {
  readonly deadline: number;
  readonly wordDeadline: number;
  words = WORD_DIFF_BUDGET;
  constructor(ms = DIFF_TIME_BUDGET_MS) {
    this.deadline = Date.now() + ms;
    this.wordDeadline = Date.now() + ms / 2;
  }
  /** Milliseconds left for the next jsdiff call; throws once the budget is spent. */
  remaining(): number {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new TooComplex();
    return left;
  }
}

/**
 * Word ops, or `undefined` when the pair is too large, too different, or the file's word budget
 * is spent. Missing highlights never truncate a diff.
 */
function words(base: string, head: string, budget: DiffBudget): WordOp[] | undefined {
  if (base.length > MAX_WORD_DIFF || head.length > MAX_WORD_DIFF) return undefined;
  if (base.length + head.length > budget.words) return undefined;
  const left = budget.wordDeadline - Date.now();
  if (left <= 0) {
    budget.words = 0;
    return undefined;
  }
  budget.words -= base.length + head.length;
  const parts = diffWordsWithSpace(base, head, {
    maxEditLength: MAX_WORD_EDIT_LENGTH,
    timeout: left,
  });
  // Too many edits or out of time: this pair (or the rest of the file) has no highlights.
  if (!parts) return undefined;
  return parts.map((part) => ({
    op: part.added ? "insert" : part.removed ? "delete" : "equal",
    text: part.value,
  }));
}

const wordSet = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** Jaccard overlap of word sets: 0 (unrelated) to 1 (same words). */
function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

function unpack(value: string): Block {
  const at = value.indexOf("\u0000");
  const kind = value.slice(0, at);
  const known: BlockKind[] = ["heading", "paragraph", "list-item", "table", "code", "other"];
  return { kind: known.find((item) => item === kind) ?? "other", text: value.slice(at + 1) };
}

/**
 * LCS over blocks; adjacent delete+insert runs of the same kind pair into replacements.
 * Throws `TooComplex` when the block LCS or the word diffs run out of budget.
 */
export function diffBlocks(base: Block[], head: Block[], budget = new DiffBudget()): DiffBlock[] {
  const pack = (block: Block) => `${block.kind}\u0000${block.text}`;
  // An added or removed file is one change; it needs no edit search.
  const changes =
    !base.length || !head.length
      ? [
          ...(base.length ? [{ removed: true, added: false, value: base.map(pack) }] : []),
          ...(head.length ? [{ removed: false, added: true, value: head.map(pack) }] : []),
        ]
      : diffArrays(base.map(pack), head.map(pack), {
          maxEditLength: MAX_EDIT_LENGTH,
          timeout: budget.remaining(),
        });
  if (!changes) throw new TooComplex();
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
    // Pairing is removed × added similarity checks; past the cap, show plain deletes and inserts.
    if (removed.length * added.length > MAX_PAIRINGS) {
      for (const before of removed)
        ops.push({ op: "delete", kind: before.kind, base_text: before.text });
      for (const after of added)
        ops.push({ op: "insert", kind: after.kind, head_text: after.text });
      continue;
    }
    const pending = added.map((block) => ({
      kind: block.kind,
      text: block.text,
      words: wordSet(block.text),
    }));
    for (const before of removed) {
      budget.remaining();
      // Pair with the most similar insertion of the same kind; unrelated blocks stay separate.
      let match = -1;
      let best = 0.25;
      let beforeWords: Set<string> | undefined;
      pending.forEach((after, at) => {
        if (after.kind !== before.kind) return;
        beforeWords ??= wordSet(before.text);
        const score = similarity(beforeWords, after.words);
        if (score > best) {
          best = score;
          match = at;
        }
      });
      if (match >= 0) {
        for (const extra of pending.splice(0, match))
          ops.push({ op: "insert", kind: extra.kind, head_text: extra.text });
        const after = pending.shift()!;
        const changed = words(before.text, after.text, budget);
        ops.push({
          op: "replace",
          kind: before.kind,
          base_text: before.text,
          head_text: after.text,
          ...(changed ? { words: changed } : {}),
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

export const splitLines = (value: string): string[] => value.replace(/\n$/, "").split("\n");

/**
 * A unified line diff with word highlights inside changed line pairs.
 * Throws `TooComplex` when the line diff or the word diffs run out of budget.
 */
export function diffTextLines(
  base: string,
  head: string,
  context = 3,
  budget = new DiffBudget(),
): LineDiffRow[] {
  const rows: LineDiffRow[] = [];
  let baseLine = 1;
  let headLine = 1;
  const parts =
    !base || !head
      ? [
          ...(base ? [{ removed: true, added: false, value: base }] : []),
          ...(head ? [{ removed: false, added: true, value: head }] : []),
        ]
      : diffLines(base, head, { maxEditLength: MAX_EDIT_LENGTH, timeout: budget.remaining() });
  if (!parts) throw new TooComplex();
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
    const pairs = removed.map((text, at) => {
      const pair = added[at];
      return pair === undefined ? undefined : words(text, pair, budget);
    });
    removed.forEach((text, at) => {
      const changed = pairs[at];
      rows.push({
        op: "delete",
        base: baseLine++,
        text,
        ...(changed ? { words: changed.filter((word) => word.op !== "insert") } : {}),
      });
    });
    added.forEach((text, at) => {
      const changed = pairs[at];
      rows.push({
        op: "insert",
        head: headLine++,
        text,
        ...(changed ? { words: changed.filter((word) => word.op !== "delete") } : {}),
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

const lineCount = (text: string): number => {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
  return count;
};

/** Diffs one file. `null` text means the side doesn't exist; `undefined` means it's too large. */
export function diffFile(
  file: CompareFile,
  baseText: string | null | undefined,
  headText: string | null | undefined,
  mode: "blocks" | "lines",
  budget = new DiffBudget(),
): FileDiff {
  const kind = fileKind(file.mime);
  const empty = { ops: [], hunks: [], folded_after: 0 };
  const truncated = (reason: TruncatedReason): FileDiff => ({
    path: file.path,
    status: file.status,
    kind,
    truncated: true,
    truncated_reason: reason,
    ...empty,
  });
  if (kind !== "text")
    return { path: file.path, status: file.status, kind, truncated: false, ...empty };
  if (baseText === undefined || headText === undefined) return truncated("size");
  const before = baseText ?? "";
  const after = headText ?? "";
  try {
    if (mode === "lines" || !isMarkdown(file.mime)) {
      if (lineCount(before) > MAX_LINES || lineCount(after) > MAX_LINES) return truncated("lines");
      return {
        path: file.path,
        status: file.status,
        kind,
        truncated: false,
        ...empty,
        lines: diffTextLines(before, after, 3, budget),
      };
    }
    const baseBlocks = splitBlocks(before);
    const headBlocks = splitBlocks(after);
    if (baseBlocks.length > MAX_BLOCKS || headBlocks.length > MAX_BLOCKS)
      return truncated("blocks");
    const ops = diffBlocks(file.base ? baseBlocks : [], file.head ? headBlocks : [], budget);
    return { path: file.path, status: file.status, kind, truncated: false, ops, ...toHunks(ops) };
  } catch (error) {
    if (error instanceof TooComplex) return truncated("complex");
    throw error;
  }
}

const textBytes = (value: string | undefined) => (value ? 2 * value.length + 48 : 0);
const wordBytes = (list: readonly WordOp[] | undefined) =>
  list ? list.reduce((sum, word) => sum + 64 + 2 * word.text.length, 0) : 0;
/** Rough heap size of a diff, for the cache's byte budget. */
export function diffBytes(diff: FileDiff): number {
  let total = 256;
  for (const op of diff.ops)
    total += 96 + textBytes(op.base_text) + textBytes(op.head_text) + wordBytes(op.words);
  // Hunks share block objects with ops; count their arrays only.
  for (const hunk of diff.hunks) total += 64 + 8 * hunk.blocks.length;
  for (const row of diff.lines ?? []) total += 96 + textBytes(row.text) + wordBytes(row.words);
  return total;
}

/**
 * An LRU keyed by (base hash, head hash, mode), bounded by approximate heap bytes. Diffs are
 * functions of content, except that word highlights can be dropped when time runs short.
 */
export class DiffCache {
  private readonly entries = new Map<string, { value: FileDiff; bytes: number }>();
  private readonly maxBytes: number;
  private total = 0;
  constructor(maxBytes = 32 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }
  get bytes(): number {
    return this.total;
  }
  get size(): number {
    return this.entries.size;
  }
  get(key: string): FileDiff | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.value;
  }
  set(key: string, value: FileDiff): void {
    this.delete(key);
    const bytes = diffBytes(value);
    // One entry may use at most a quarter of the budget, so a huge diff can't flush the rest.
    if (bytes > this.maxBytes / 4) return;
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    while (this.total > this.maxBytes) this.delete(this.entries.keys().next().value ?? "");
  }
  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.bytes;
  }
}

type DiffJob = {
  file: CompareFile;
  base: string | null | undefined;
  head: string | null | undefined;
  mode: "blocks" | "lines";
};
export type WorkerJob = ({ kind: "diff" } & DiffJob) | { kind: "fragments"; sources: string[] };
/** Inputs up to this size (both sides, UTF-16 units) are diffed inline; larger go to a worker. */
export const INLINE_DIFF_MAX = 32 * 1024;

function startDiffWorker(): Worker {
  const entry = workerEntry("compare-worker");
  return new Worker(entry.url, {
    execArgv: entry.execArgv,
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
  });
}

/**
 * Runs diffs and Changes-page Markdown fragments off the event loop: a few long-lived workers,
 * one job each at a time, and a hard wall-clock limit per job. A worker that overruns is
 * terminated and the job falls back (a truncated diff, or fragments shown as source), so a
 * pathological input can't hold the writer.
 */
export class DiffWorkers {
  private readonly idle: Worker[] = [];
  private readonly waiting: Array<() => void> = [];
  private running = 0;
  private readonly max: number;
  private readonly wallMs: number;
  constructor(options: { max?: number; wallMs?: number } = {}) {
    this.max = options.max ?? 2;
    this.wallMs = options.wallMs ?? DIFF_TIME_BUDGET_MS * 4;
  }

  /** Diffs small inputs inline and everything else in a worker. */
  async diff(job: DiffJob): Promise<FileDiff> {
    const size = (job.base?.length ?? 0) + (job.head?.length ?? 0);
    if (size <= INLINE_DIFF_MAX || fileKind(job.file.mime) !== "text")
      return diffFile(job.file, job.base, job.head, job.mode);
    const result = await this.run({ kind: "diff", ...job });
    return isFileDiff(result)
      ? result
      : {
          path: job.file.path,
          status: job.file.status,
          kind: "text",
          truncated: true,
          truncated_reason: "complex",
          ops: [],
          hunks: [],
          folded_after: 0,
        };
  }

  /** Renders Markdown fragments in a worker; `null` entries weren't rendered (show source). */
  async fragments(sources: string[]): Promise<(string | null)[]> {
    if (!sources.length) return [];
    const result = await this.run({ kind: "fragments", sources });
    return Array.isArray(result) && result.length === sources.length
      ? result.map((item) => (typeof item === "string" ? item : null))
      : sources.map(() => null);
  }

  /** Stops idle workers (tests and shutdown). */
  async close(): Promise<void> {
    await Promise.all(this.idle.splice(0).map((worker) => worker.terminate()));
  }

  private async run(job: WorkerJob): Promise<unknown> {
    if (this.running >= this.max) await new Promise<void>((go) => this.waiting.push(go));
    this.running++;
    try {
      return await this.dispatch(job);
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Resolves with the worker's reply, or `undefined` if the worker failed or overran. */
  private dispatch(job: WorkerJob): Promise<unknown> {
    const label = job.kind === "diff" ? `diff of ${job.file.path}` : "fragment rendering";
    let worker: Worker;
    try {
      worker = this.idle.pop() ?? startDiffWorker();
    } catch (error) {
      console.error(`Diff worker failed to start: ${String(error)}`);
      return Promise.resolve(undefined);
    }
    worker.ref();
    return new Promise<unknown>((resolve) => {
      const finish = (result: unknown, reuse: boolean) => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        if (reuse) {
          worker.unref();
          this.idle.push(worker);
        } else void worker.terminate();
        resolve(result);
      };
      const onMessage = (result: unknown) => finish(result, true);
      const onError = (error: Error) => {
        console.error(`Diff worker failed (${label}): ${error.message}`);
        finish(undefined, false);
      };
      const onExit = () => finish(undefined, false);
      const timer = setTimeout(() => {
        console.error(`Diff worker overran ${this.wallMs} ms (${label}); stopped it`);
        finish(undefined, false);
      }, this.wallMs);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      worker.postMessage(job, []);
    });
  }
}

const isFileDiff = (value: unknown): value is FileDiff =>
  typeof value === "object" && value !== null && "truncated" in value && "ops" in value;
