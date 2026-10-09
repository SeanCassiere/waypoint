import { describe, expect, it } from "vitest";

import type { PurgingCollection } from "../src/read-model.ts";
import { PurgeRow, purgeState, type PurgeLink } from "../src/viewer/purge.tsx";

const NOW = 1_760_000_000_000;
function row(fields: Partial<PurgingCollection>): PurgingCollection {
  return {
    collection_id: "col_x",
    public_id: "pub",
    title: "T",
    step: 0,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    requested_at: NOW - 60_000,
    ...fields,
  };
}

describe("purgeState (OW-14)", () => {
  it.each([
    [{ step: 0 }, { step: 1, kind: "running", nextAt: null }],
    [{ step: 1 }, { step: 2, kind: "running", nextAt: null }],
    [
      { step: 2, next_attempt_at: NOW + 1 },
      { step: 3, kind: "waiting", nextAt: NOW + 1 },
    ],
    [
      { step: 2, next_attempt_at: NOW },
      { step: 3, kind: "running", nextAt: NOW },
    ],
    [
      { step: 2, next_attempt_at: NOW - 1 },
      { step: 3, kind: "running", nextAt: NOW - 1 },
    ],
    [{ step: 2 }, { step: 3, kind: "running", nextAt: null }],
    [
      { step: 0, last_error: "503", next_attempt_at: NOW + 5 },
      { step: 1, kind: "retrying", nextAt: NOW + 5 },
    ],
    [
      { step: 1, last_error: "x" },
      { step: 2, kind: "retrying", nextAt: null },
    ],
    [
      { step: 2, last_error: "x", next_attempt_at: NOW + 9 },
      { step: 3, kind: "retrying", nextAt: NOW + 9 },
    ],
    [{ step: -1 }, { step: 1, kind: "running", nextAt: null }],
    [{ step: 7 }, { step: 3, kind: "running", nextAt: null }],
  ] as const)("%o → %o", (fields, expected) => {
    expect(purgeState(row(fields), NOW)).toEqual(expected);
  });
});

function link(label: string): PurgeLink {
  return { label, revision_display_number: null, revoked_at: NOW - 61_000, pushed_at: null };
}

/** The meta line's text for a Trash row with `n` revoked links. */
async function meta(n: number): Promise<string> {
  const links = Array.from({ length: n }, (_, i) => link(`L${i + 1}`));
  const node = await PurgeRow({
    row: row({}),
    page: "trash",
    now: NOW,
    links,
    syncEnabled: false,
  });
  const html = node.toString();
  return html
    .slice(html.indexOf('<p class="meta">'))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

describe("PurgeRow revoked links (OW-14)", () => {
  it("lists at most three, then the pinned `+{n} more links`", async () => {
    expect(await meta(3)).not.toContain("more links");
    expect(await meta(4)).toContain("+1 more links");
    expect(await meta(4)).not.toContain("L4");
    expect(await meta(6)).toContain("+3 more links");
  });
});
