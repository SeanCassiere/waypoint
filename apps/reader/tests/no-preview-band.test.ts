import { publicShellCss, publicShellScript, renderPublicShell } from "@waypoint/ui";
import { describe, expect, it } from "vitest";

// RX-10: the writer injects its "Public preview" band into the shell for the owner only, so the
// shell the reader serves (and its CSS and script) never carries any part of it.
describe("public shell on the reader", () => {
  it("never contains the owner's preview band", () => {
    const html = renderPublicShell({
      title: "Plan",
      files: [{ path: "index.md" }, { path: "notes/sources.md" }],
      head: "index.md",
      current: "index.md",
      fileHref: (path) => `/s/t/c/p/${path}`,
      frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
      updatedAt: Date.UTC(2026, 9, 7, 22, 8),
      snapshotAt: null,
    });
    for (const text of [html, publicShellCss, publicShellScript]) {
      expect(text).not.toContain("data-preview-banner");
      expect(text).not.toContain("Public preview");
      expect(text).not.toContain("wp-pv");
    }
  });
});
