// The demo reader (scripts/demo-reader.ts) serves a demo writer's share links from its local
// data, and a revocation reaches it without a push.
import { z } from "zod";

import {
  assert,
  collectConsole,
  cspProblems,
  freePort,
  startDemoReader,
  startDemoWriter,
  type ReaderScenario,
} from "../harness.ts";

const shareLinks = z.object({
  share_links: z.array(
    z.object({ id: z.string(), label: z.string().nullable(), url: z.string().nullish() }),
  ),
});

const scenario: ReaderScenario = {
  name: "FA3 demo reader serves a demo writer's links",
  async run(ctx) {
    let port = await freePort();
    let writer = await startDemoWriter({
      env: { WAYPOINT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` },
    });
    // The writer picks its own free port; in the rare case it took the reader's, start over once.
    if (new URL(writer.base).port === String(port)) {
      await writer.stop();
      port = await freePort();
      writer = await startDemoWriter({
        env: { WAYPOINT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` },
      });
    }
    const reader = await startDemoReader(writer.dataDir, port);

    const listed = await writer.fetch("/api/share-links?limit=200");
    assert.equal(listed.status, 200);
    const link = shareLinks
      .parse(await listed.json())
      .share_links.find((view) => view.label === "Design review — Sam");
    assert.ok(link, "the seeded link is listed");
    const url = link.url ?? "";
    assert.ok(url.startsWith(`http://127.0.0.1:${port}/s/wps_`), url);

    const { page } = await ctx.newPage();
    const log = collectConsole(page);
    await page.goto(url);
    assert.equal((await page.textContent("h1"))?.trim(), "Webhook idempotency research");
    await page.waitForFunction(
      `[...document.querySelectorAll("iframe")].some((f) => f.src.startsWith(${JSON.stringify(`${reader.origin}/x/`)}))`,
    );
    assert.ok(
      page.frames().some((frame) => frame.url().startsWith(`${reader.origin}/x/`)),
      "the document frame is served by the demo reader",
    );
    assert.deepEqual(cspProblems(log), []);

    const unknown = await fetch(`${reader.origin}/s/wps_doesnotexist/c/x/`);
    const denial = { status: unknown.status, body: await unknown.text() };

    const revoked = await writer.fetch(`/api/share-links/${link.id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(revoked.status, 200);
    // The 0.5 s snapshot check plus the reader's 5 s link cache: poll for up to 15 s.
    const poll = async (attempts: number): Promise<{ status: number; body: string }> => {
      const response = await fetch(url);
      const seen = { status: response.status, body: await response.text() };
      if (attempts <= 1 || (seen.status === denial.status && seen.body === denial.body))
        return seen;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      return poll(attempts - 1);
    };
    assert.deepEqual(await poll(30), denial, "the revoked link answers like an unknown one");
  },
};
export default scenario;
