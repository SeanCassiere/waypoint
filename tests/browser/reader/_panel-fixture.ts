// Shared by the Files panel scenarios (panel.ts, panel-peek.ts; D74): a reader serving a
// multi-file collection and a one-file collection, each behind its own share link.
import { hashShareToken, newShareToken } from "@waypoint/core";
import type { Page } from "playwright";

import { assert, rawCap, readerTestDb, startReader } from "../harness.ts";

const HASH = "sha256:" + "5".repeat(64);
interface Fixture {
  title: string;
  col: { id: string; pub: string };
  rev: { id: string; pub: string };
  link: string;
  files: readonly string[];
}
const MULTI: Fixture = {
  title: "Panel fixture",
  col: { id: "col_" + "p".repeat(26), pub: "pppppppppppp" },
  rev: { id: "rev_" + "0".repeat(25) + "p", pub: "p5p5p5p5p5p5" },
  link: "shl_" + "0".repeat(25) + "p",
  files: [
    "index.html",
    "notes.html",
    "docs/a.html",
    "docs/b.html",
    ...Array.from({ length: 40 }, (_, i) => `many/file-${String(i).padStart(2, "0")}.html`),
  ],
};
const SINGLE: Fixture = {
  title: "One file",
  col: { id: "col_" + "q".repeat(26), pub: "qqqqqqqqqqqq" },
  rev: { id: "rev_" + "0".repeat(25) + "q", pub: "q5q5q5q5q5q5" },
  link: "shl_" + "0".repeat(25) + "q",
  files: ["index.html"],
};

export interface PanelReader {
  /** The multi-file link's share token (storage must never contain it). */
  token: string;
  /** Shell URL of the multi-file link (append a path for a file). */
  shell: string;
  /** Shell URL of the one-file link. */
  single: string;
  /** Opens a shell URL and waits for the document frame. */
  open(page: Page, url: string): Promise<void>;
}

/** Polls a page expression from Node: the shell's CSP blocks Playwright's in-page polling. */
export async function until(page: Page, expression: string, timeout = 5000): Promise<void> {
  const start = performance.now();
  // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one evaluation at a time.
  while ((await page.evaluate(expression)) !== true) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${expression}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling, one evaluation at a time.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Seeds both collections and starts a reader over them (stopped by the runner's cleanup). */
export async function panelReader(): Promise<PanelReader> {
  const db = readerTestDb();
  const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
  ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,1,1)", HASH);
  const tokens = new Map<Fixture, string>();
  for (const f of [MULTI, SINGLE]) {
    const token = newShareToken();
    tokens.set(f, token);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      f.col.id,
      f.col.pub,
      f.title,
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      f.rev.id,
      f.rev.pub,
      f.col.id,
      "index.html",
    );
    for (const path of f.files)
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,1)",
        f.rev.id,
        path,
        HASH,
        "text/html",
      );
    ins(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
      f.link,
      // oxlint-disable-next-line eslint/no-await-in-loop -- Two fixtures, seeded in order.
      await hashShareToken(token),
      f.col.id,
      null,
      null,
      null,
    );
  }
  const reader = await startReader({
    db,
    blob: () =>
      new Response(
        "<!doctype html><title>doc</title><p>The document, with enough text to select.</p>",
      ),
  });
  const shell = (f: Fixture) => `${reader.origin}/s/${tokens.get(f)}/c/${f.col.pub}/`;
  const frames = [MULTI, SINGLE].map(
    (f) => `${reader.origin}/x/${f.link}.${rawCap(f.link, f.rev.pub)}/r/${f.rev.pub}/`,
  );
  return {
    token: tokens.get(MULTI)!,
    shell: shell(MULTI),
    single: shell(SINGLE),
    async open(page, url) {
      const response = await page.goto(url);
      assert.equal(response?.status(), 200, `loads ${url}`);
      await until(
        page,
        `[...document.querySelectorAll("iframe")].some((f) => ${JSON.stringify(frames)}.some((b) => f.src.startsWith(b)))`,
      );
    },
  };
}
