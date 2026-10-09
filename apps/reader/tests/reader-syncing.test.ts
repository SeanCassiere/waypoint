// RX-11: a following link's shell says when a newer revision is still syncing.
import { hashShareToken, newShareToken, shareShellUrl } from "@waypoint/core";
import { beforeEach, describe, expect, it } from "vitest";

import { createReaderApp, type ReaderDb, type ReaderEnv } from "../src/app.ts";

const collection = "0123456789ab";
const firstPub = "bcdefghjkmnp";
const hash = `sha256:${"a".repeat(64)}`;
const token = newShareToken();
const base = "https://reader.example.test";
const NOW = Date.UTC(2026, 9, 9, 12, 0);
const SENTENCE = "A newer version is being synced. It will appear here once it has uploaded.";
const env: ReaderEnv = {
  TURSO_DATABASE_URL: "turso://test",
  TURSO_READONLY_TOKEN: "test",
  R2_ACCOUNT_ID: "test",
  R2_READER_ACCESS_KEY_ID: "test",
  R2_READER_SECRET_ACCESS_KEY: "test",
  R2_BUCKET: "test",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
type LinkRow = {
  id: string;
  collection_id: string;
  revision_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  public_id: string;
  title: string;
  deleted_at: number | null;
};
const revision = { id: "rev_one", public_id: firstPub, head_path: "index.md", created_at: 1000 };
const files = [
  { path: "index.md", blob_hash: hash, mime: "text/markdown" },
  { path: "other.txt", blob_hash: hash, mime: "text/plain" },
];
let link: LinkRow;
/** The `collection_syncing` row, or what its query throws. */
let syncingRow: { until: number } | undefined;
let syncingError: Error | undefined;
let reads: string[];

function fixture() {
  const db: ReaderDb = {
    async all<T>(sql: string, args: (string | number)[] = []): Promise<T[]> {
      reads.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("FROM collection_syncing")) {
        if (syncingError) throw syncingError;
        rows = syncingRow && args[0] === link.collection_id ? [syncingRow] : [];
      } else if (sql.includes("FROM share_links"))
        rows =
          args[0] === (await hashShareToken(token)) || args[0] === link.id
            ? [
                {
                  ...link,
                  pinned_public_id: link.revision_id ? revision.public_id : null,
                  pinned_head_path: link.revision_id ? revision.head_path : null,
                  pinned_created_at: link.revision_id ? revision.created_at : null,
                },
              ]
            : [];
      else if (sql.includes("FROM revisions")) rows = [revision];
      else if (sql.includes("FROM revision_files") && sql.includes("path=?"))
        rows = files.filter((item) => item.path === args[1]);
      else if (sql.includes("FROM revision_files")) rows = files;
      // This fake is intentionally the trust boundary for typed SQL rows.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return rows.map((item) => item as T);
    },
  };
  const app = createReaderApp({
    db: () => db,
    blob: () => ({
      probe: () => Promise.resolve(new Response("ok")),
      fetch: () => Promise.resolve(new Response("source")),
    }),
    now: () => NOW,
  });
  return {
    app,
    bindings: { ...env, TOKEN_MISS_LIMITER: { limit: () => Promise.resolve({ success: true }) } },
  };
}
const follow = () => shareShellUrl(base, token, collection);
const syncingReads = () => reads.filter((sql) => sql.includes("collection_syncing"));
async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].toSorted((a, b) => a[0].localeCompare(b[0])),
    body: await response.text(),
  };
}

beforeEach(() => {
  link = {
    id: "shl_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    collection_id: "col_test",
    revision_id: null,
    expires_at: null,
    revoked_at: null,
    public_id: collection,
    title: "Shared",
    deleted_at: null,
  };
  syncingRow = undefined;
  syncingError = undefined;
  reads = [];
});

describe("syncing note", () => {
  it("shows the note on a following link while now < until", async () => {
    syncingRow = { until: NOW + 3_600_000 };
    const { app, bindings } = fixture();
    const response = await app.request(follow(), {}, bindings);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('class="sync"');
    expect(html).toContain(SENTENCE);
    expect(html).toContain("Newer version syncing");
    expect(syncingReads()).toHaveLength(1);
  });

  it("hides the note once until is reached", async () => {
    syncingRow = { until: NOW };
    const { app, bindings } = fixture();
    const response = await app.request(follow(), {}, bindings);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('class="sync"');
  });

  it("serves the shell without the note when the lookup fails", async () => {
    syncingError = new Error("no such table: collection_syncing");
    const { app, bindings } = fixture();
    const response = await app.request(follow(), {}, bindings);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('class="sync"');
    expect(html).not.toContain("Newer version syncing");
  });

  it("never looks it up for a pinned link", async () => {
    link.revision_id = revision.id;
    syncingRow = { until: NOW + 3_600_000 };
    const { app, bindings } = fixture();
    const response = await app.request(
      shareShellUrl(base, token, collection, firstPub),
      {},
      bindings,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('class="sync"');
    expect(html).not.toContain("Newer version syncing");
    expect(syncingReads()).toEqual([]);
  });

  it("never looks it up for raw content", async () => {
    syncingRow = { until: NOW + 3_600_000 };
    const { app, bindings } = fixture();
    const shell = await (await app.request(follow(), {}, bindings)).text();
    const frame = /data-base="([^"]+)"/.exec(shell)?.[1];
    if (!frame) throw new Error("Frame base missing");
    reads = [];
    const raw = await app.request(`${frame}other.txt`, {}, bindings);
    expect(raw.status).toBe(200);
    expect(syncingReads()).toEqual([]);
  });

  it("answers a revoked link exactly as without a syncing row", async () => {
    link.revoked_at = 1;
    const { app, bindings } = fixture();
    const without = await snapshot(await app.request(follow(), {}, bindings));
    syncingRow = { until: NOW + 3_600_000 };
    const withRow = await snapshot(await fixture().app.request(follow(), {}, bindings));
    expect(without.status).toBe(404);
    expect(withRow).toEqual(without);
    expect(syncingReads()).toEqual([]);
  });
});
