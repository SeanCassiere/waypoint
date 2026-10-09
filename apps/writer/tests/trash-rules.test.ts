// OW-07: the restore body requires a choice when the collection has paused links (revoke, then
// undelete; or undelete alone), the flash says what happened to them, and the Trash chip names them.
import { describe, expect, it } from "vitest";

import {
  normTyped,
  pausedChipText,
  purgeFlashText,
  purgeMatch,
  restoreFlashText,
  restoreRequests,
  type PausedLink,
} from "../src/client/trash-rules.ts";

const undelete = { method: "POST", url: "/api/collections/col_x/undelete" };
const revokeAll = { method: "POST", url: "/api/collections/col_x/share-links/revoke-all" };
const link = (label: string | null, n = 0): PausedLink => ({
  id: `shl_${n}`,
  label,
  revision_display_number: null,
  expires_at: null,
});

describe("restoreRequests", () => {
  it("makes no request while a choice about paused links is missing", () => {
    expect(restoreRequests("col_x", 1, null)).toBeNull();
    expect(restoreRequests("col_x", 2, null)).toBeNull();
  });
  it("revokes, then undeletes", () => {
    expect(restoreRequests("col_x", 1, "revoke")).toEqual([revokeAll, undelete]);
  });
  it("only undeletes when the links stay, or there are none", () => {
    expect(restoreRequests("col_x", 1, "keep")).toEqual([undelete]);
    expect(restoreRequests("col_x", 0, null)).toEqual([undelete]);
  });
  it("encodes the collection id", () => {
    expect(restoreRequests("a/b c", 1, "revoke")).toEqual([
      { method: "POST", url: "/api/collections/a%2Fb%20c/share-links/revoke-all" },
      { method: "POST", url: "/api/collections/a%2Fb%20c/undelete" },
    ]);
  });
});

describe("restoreFlashText", () => {
  it("says what happened to the links", () => {
    expect(restoreFlashText("A", 0, null)).toBe("Restored “A”.");
    expect(restoreFlashText("A", 1, "revoke")).toBe("Restored “A”. Its public link was revoked.");
    expect(restoreFlashText("A", 2, "revoke")).toBe(
      "Restored “A”. Its 2 public links were revoked.",
    );
    expect(restoreFlashText("A", 1, "keep")).toBe("Restored “A”. Its public link works again.");
    expect(restoreFlashText("A", 3, "keep")).toBe("Restored “A”. Its 3 public links work again.");
  });
});

describe("pausedChipText", () => {
  it("counts every paused link and quotes at most two labels", () => {
    expect(pausedChipText([])).toBe("");
    expect(pausedChipText([link("Vendor debug")])).toBe("1 link paused · “Vendor debug”");
    expect(pausedChipText([link(null, 1), link(null, 2)])).toBe("2 links paused");
    expect(pausedChipText([link("A", 1), link("B", 2), link("C", 3)])).toBe(
      "3 links paused · “A”, “B” +1",
    );
    expect(pausedChipText([link(null, 1), link("A", 2)])).toBe("2 links paused · “A”");
  });
});

// OW-14: Purge accepts the title or the public ID, loosely, and says what it did.
describe("purge rules", () => {
  const target = { title: "Leaked .env in run output (do not share)", publicId: "22g2mtaktr5g" };
  it("matches the title or the public ID, ignoring case and extra spaces", () => {
    expect(normTyped("  A \t b\n C ")).toBe("a b c");
    expect(purgeMatch("  leaked .ENV in   run output (do not share) ", target)).toBe("title");
    expect(purgeMatch("22G2MTAKTR5G", target)).toBe("public ID");
    expect(purgeMatch("", target)).toBeNull();
    expect(purgeMatch("   ", target)).toBeNull();
    expect(purgeMatch("leaked", target)).toBeNull();
  });
  it("flashes what happened", () => {
    expect(purgeFlashText("P", 0, false)).toBe("Purging “P”. Progress is listed here ↑");
    expect(purgeFlashText("P", 1, false)).toBe(
      "Purging “P”. Its 1 public link was revoked just now. Progress is listed here ↑",
    );
    expect(purgeFlashText("P", 2, false)).toBe(
      "Purging “P”. Its 2 public links were revoked just now. Progress is listed here ↑",
    );
    expect(purgeFlashText("P", 1, true)).toBe("Purged “P”. Nothing had reached the cloud.");
  });
});
