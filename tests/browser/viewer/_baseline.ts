// State shared by the baseline scenarios 00–05 (not by item scenarios): the "Browser collection"
// (#1, #2; 02 adds #3) and one page that every baseline scenario drives in turn.
import type { Page } from "playwright";

import { onCleanup, type ViewerContext, type WriteResult, type WriterHandle } from "../harness.ts";

export interface BaselineState {
  first: WriteResult;
  second: WriteResult;
  latest: string;
  pinned: string;
  secondPinned: string;
  page: Page;
  rawRequests: string[];
  third?: WriteResult;
  thirdPinned?: string;
}

let state: Promise<BaselineState> | undefined;
/** Seeds the baseline collection and opens the shared page, once per run. */
export function baseline(ctx: ViewerContext): Promise<BaselineState> {
  state ??= seed(ctx);
  return state;
}

async function seed(ctx: ViewerContext): Promise<BaselineState> {
  const api: WriterHandle["api"] = (path, body) => ctx.writer.api(path, body);
  const write: WriterHandle["write"] = (path, content) => ctx.writer.write(path, content);
  const first = await api("/api/collections", {
    title: "Browser collection",
    files: [
      await write(
        "index.md",
        "# Home\n\n[Notes](notes/b.md)\n\n[Source](notes/b.md?source#hello)\n",
      ),
      await write("notes/b.md", "# Hello\n\n[Home](../index.md)\n"),
    ],
  });
  const second = await api(`/api/collections/${first.collection_id}/revisions`, {
    message: "Second",
    files: [await write("index.md", "# Second\n\n[Notes](notes/b.md)\n")],
  });
  const latest = new URL(first.latest_url).pathname;
  const pinned = new URL(first.url).pathname;
  const secondPinned = new URL(second.url).pathname;
  // Opened directly, not through ctx.newPage: the runner closes those after each scenario, and
  // this page lives through 00–05.
  const context = await ctx.browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  onCleanup(() => context.close());
  const page = await context.newPage();
  // Script errors abort every later binding on the page, so any one fails the run.
  ctx.watchErrors(page, "baseline");
  const rawRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/raw/r/")) rawRequests.push(request.url());
  });
  return { first, second, latest, pinned, secondPinned, page, rawRequests };
}
