// RX-05: CSV is never a blank frame. The raw route serves CSV and TSV as plain text, so the
// sandboxed frame shows their text instead of a download the sandbox blocks.
import { hashShareToken, newShareToken } from "@waypoint/core";

import {
  assert,
  collectConsole,
  cspProblems,
  rawCap,
  readerTestDb,
  startReader,
  type ReaderScenario,
} from "../harness.ts";

const COL = { id: "col_" + "e".repeat(26), pub: "eeeeeeeeeeee" };
const REV = { id: "rev_" + "0".repeat(25) + "5", pub: "e5e5e5e5e5e5" };
const LINK = "shl_" + "0".repeat(25) + "5";
const FILES = [
  {
    path: "data.csv",
    mime: "text/csv",
    hash: "sha256:" + "5".repeat(64),
    body: "region,requests\neu-west,1200\n",
    first: "region,requests",
  },
  {
    path: "table.tsv",
    mime: "text/tab-separated-values",
    hash: "sha256:" + "6".repeat(64),
    body: "region\trequests\neu-west\t1200\n",
    first: "region\trequests",
  },
] as const;

const scenario: ReaderScenario = {
  name: "RX-05 CSV and TSV show their text in the frame, never a blank frame or a download",
  async run(ctx) {
    const token = newShareToken();
    const db = readerTestDb();
    const ins = (sql: string, ...a: (string | number | null)[]) => db.prepare(sql).run(...a);
    ins(
      "INSERT INTO collections (id,public_id,title,created_at) VALUES (?,?,?,1)",
      COL.id,
      COL.pub,
      "Tables",
    );
    ins(
      "INSERT INTO revisions (id,public_id,collection_id,head_path,created_at) VALUES (?,?,?,?,1)",
      REV.id,
      REV.pub,
      COL.id,
      "data.csv",
    );
    for (const f of FILES) {
      ins("INSERT INTO blobs (hash,size,uploaded_at) VALUES (?,?,1)", f.hash, f.body.length);
      ins(
        "INSERT INTO revision_files (revision_id,path,blob_hash,mime,size) VALUES (?,?,?,?,?)",
        REV.id,
        f.path,
        f.hash,
        f.mime,
        f.body.length,
      );
    }
    ins(
      "INSERT INTO share_links (id,token_hash,collection_id,revision_id,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,1)",
      LINK,
      await hashShareToken(token),
      COL.id,
      null,
      null,
      null,
    );
    const bodies = new Map<string, string>(FILES.map((f) => [f.hash, f.body]));
    const reader = await startReader({
      db,
      blob: (hash) => {
        const body = bodies.get(hash);
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
      },
    });
    const shellBase = `${reader.origin}/s/${token}/c/${COL.pub}/`;
    const frameBase = `${reader.origin}/x/${LINK}.${rawCap(LINK, REV.pub)}/r/${REV.pub}/`;

    const { page } = await ctx.newPage();
    const log = collectConsole(page);
    const downloads: string[] = [];
    page.on("download", (d) => downloads.push(d.url()));
    const check = async (f: (typeof FILES)[number]) => {
      const url = frameBase + f.path;
      // Before RX-05 the sandboxed frame never navigated: Chromium treats text/csv as a download.
      const navigated = page.waitForEvent("framenavigated", {
        predicate: (fr) => fr !== page.mainFrame() && fr.url() === url,
        timeout: 10_000,
      });
      const response = await page.goto(shellBase + f.path);
      assert.equal(response?.status(), 200, `${f.path}: shell loads`);
      assert.equal(await page.getAttribute("#doc", "src"), url, `${f.path}: frame URL`);
      const frame = await navigated;
      await frame.waitForLoadState("load");
      const text = String(await frame.evaluate("document.body.innerText"));
      assert.ok(text.includes(f.first), `${f.path}: frame text ${JSON.stringify(text)}`);
    };
    for (const f of FILES)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One page, one file at a time.
      await check(f);
    assert.deepEqual(downloads, []);
    assert.deepEqual(cspProblems(log), []);
  },
};
export default scenario;
