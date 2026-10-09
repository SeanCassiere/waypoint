import { newShareToken } from "@waypoint/core";
import { describe, expect, it } from "vitest";

import { createReaderApp, type ReaderEnv } from "../src/app.ts";
import { shellScriptHash, shellStyleHash } from "../src/csp-hashes.ts";

// RX-04: image shells show the image on a stage with <img>, and their CSP lets the shell load
// images only from this response's own frame base (decision c). Other shells keep their policy.
const env: ReaderEnv = {
  TURSO_DATABASE_URL: "x",
  TURSO_READONLY_TOKEN: "x",
  R2_ACCOUNT_ID: "x",
  R2_READER_ACCESS_KEY_ID: "x",
  R2_READER_SECRET_ACCESS_KEY: "x",
  R2_BUCKET: "x",
  RAW_CAP_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};
const files = [
  { path: "index.md", mime: "text/markdown", size: 10 },
  { path: "shots/a.png", mime: "image/png", size: 2970 },
  { path: "shots/old.bmp", mime: "image/bmp", size: 4000 },
  { path: "build.zip", mime: "application/zip", size: 4_300_000 },
];
const app = createReaderApp({
  db: () => ({
    all: <T>(sql: string, args: (string | number)[] = []): Promise<T[]> => {
      const result: unknown[] = sql.includes("share_links")
        ? [
            {
              id: "shl_" + "0".repeat(26),
              collection_id: "c",
              revision_id: null,
              expires_at: null,
              revoked_at: null,
              public_id: "aaaaaaaaaaaa",
              title: "Checkout audit",
              deleted_at: null,
              pinned_public_id: null,
              pinned_head_path: null,
              pinned_created_at: null,
            },
          ]
        : sql.includes("FROM revisions")
          ? [{ id: "r", public_id: "a2a2a2a2a2a2", head_path: "index.md", created_at: 1 }]
          : sql.includes("AND path=?")
            ? files
                .filter((file) => file.path === args[1])
                .map(({ path, mime, size }) => ({
                  path,
                  mime,
                  size,
                  blob_hash: `sha256:${"1".repeat(64)}`,
                }))
            : files;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake is the typed-row boundary.
      return Promise.resolve(result as T[]);
    },
  }),
  blob: () => ({
    fetch: () => Promise.resolve(new Response("x")),
    probe: () => Promise.resolve(new Response("ok")),
  }),
});
const shellPolicy = `default-src 'none'; style-src ${shellStyleHash}; script-src ${shellScriptHash}; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
async function open(path: string): Promise<{ html: string; csp: string | null }> {
  const res = await app.request(
    `https://reader.example.test/s/${newShareToken()}/c/aaaaaaaaaaaa/${path}`,
    {},
    env,
  );
  expect(res.status).toBe(200);
  return { html: await res.text(), csp: res.headers.get("content-security-policy") };
}

describe("image shells (RX-04)", () => {
  it("shows a PNG on the stage and allows images from this revision's frame base only", async () => {
    const { html, csp } = await open("shots/a.png");
    const src = /<img src="([^"]+)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    const frameBase =
      /^https:\/\/reader\.example\.test\/x\/shl_0{26}\.[\w-]+\/r\/a2a2a2a2a2a2\//.exec(src!)?.[0];
    expect(frameBase).toBeDefined();
    expect(src).toBe(`${frameBase}shots/a.png`);
    expect(csp).toBe(
      `default-src 'none'; style-src ${shellStyleHash}; script-src ${shellScriptHash}; img-src ${frameBase}; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    expect(html).toContain('<main id="main" class="imgmain"><figure class="stage" id="doc"');
    expect(html).not.toContain("<iframe");
  });

  it("keeps today's policy for a markdown file", async () => {
    const { html, csp } = await open("");
    expect(csp).toBe(shellPolicy);
    expect(csp).not.toContain("img-src");
    expect(html).toContain('<iframe id="doc"');
  });

  it("keeps other image types in the frame, with today's policy", async () => {
    const { html, csp } = await open("shots/old.bmp");
    expect(html).toContain('<iframe id="doc"');
    expect(html).not.toContain('class="stage"');
    expect(csp).toBe(shellPolicy);
  });

  it("keeps the download card for an archive, with today's policy", async () => {
    const { html, csp } = await open("build.zip");
    expect(html).toContain('<div class="dl">');
    expect(csp).toBe(shellPolicy);
  });
});
