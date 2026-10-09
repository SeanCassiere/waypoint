import { describe, expect, it } from "vitest";

import { previewBand, type PreviewBandRow } from "../src/viewer/pages/public-preview.tsx";

// RX-10: what the ?as=public band says, on demo-shaped rows (owner decision h, context §3.8).
const row = (n: number, sync_state: PreviewBandRow["sync_state"]): PreviewBandRow => ({
  id: `rev_${String(n).padStart(2, "0")}`,
  display_number: n,
  sync_state,
});
const at = (rows: readonly PreviewBandRow[], n: number): PreviewBandRow => {
  const found = rows.find((each) => each.display_number === n);
  if (!found) throw new Error(`no #${n}`);
  return found;
};

describe("previewBand", () => {
  // Postgres on the demo: #1–#5 synced, #6 failed (a branch off #4), #7 uploading.
  const postgres = [1, 2, 3, 4, 5].map((n) => row(n, "synced"));
  postgres.push(row(6, "failed"), row(7, "pending"));

  it("says a Latest link shows the newest synced revision while the latest uploads", () => {
    const band = previewBand({
      rows: postgres,
      latestId: at(postgres, 7).id,
      revision: at(postgres, 7),
      served: at(postgres, 5),
      pinned: false,
    });
    expect(band).toEqual({
      kind: "latest-syncing",
      first: "A Latest link shows #5, the newest revision that has synced.",
      second: "Recipients see a “newer version is being synced” note until #7 finishes uploading.",
      short: "Latest links show #5",
      back: "Back to #7",
    });
    expect(`Public preview · ${band.first} ${band.second}`).toBe(
      "Public preview · A Latest link shows #5, the newest revision that has synced. Recipients see a “newer version is being synced” note until #7 finishes uploading.",
    );
  });

  it("says the latest when the newest revision has synced", () => {
    const rows = [1, 2, 3].map((n) => row(n, "synced"));
    const band = previewBand({
      rows,
      latestId: at(rows, 3).id,
      revision: at(rows, 3),
      served: at(rows, 3),
      pinned: false,
    });
    expect(band).toMatchObject({
      kind: "latest-current",
      first: "A Latest link shows #3, the latest.",
      second: null,
      short: "Latest links show #3",
      back: "Back to #3",
    });
  });

  it("names a newer revision that failed to upload", () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n, "synced"));
    rows.push(row(6, "failed"));
    const band = previewBand({
      rows,
      latestId: at(rows, 5).id,
      revision: at(rows, 5),
      served: at(rows, 5),
      pinned: false,
    });
    expect(band).toMatchObject({
      kind: "latest-failed",
      first: "A Latest link shows #5, the newest revision that has synced.",
      second: "#6 failed to upload.",
      short: "Latest links show #5",
    });
  });

  it("says an Only link shows the pinned revision and won't change", () => {
    const band = previewBand({
      rows: postgres,
      latestId: at(postgres, 7).id,
      revision: at(postgres, 3),
      served: at(postgres, 3),
      pinned: true,
    });
    expect(band).toEqual({
      kind: "pinned",
      first: "An Only #3 link shows this revision.",
      second: "It won't change.",
      short: "Only #3 links show this",
      back: "Back to #3",
    });
  });
});
