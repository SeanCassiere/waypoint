import { describe, expect, it } from "vitest";

import type { Health } from "../src/health.ts";
import { FindButton, FindDialog, Layout, type Chrome } from "../src/viewer/layout.tsx";

const health: Health = {
  state: "synced",
  label: "Synced",
  short: "Synced",
  aria: "Synced",
  failed: [],
  pending: [],
  stalled: [],
  waiting: [],
  collections: [],
  oldestPendingAt: null,
  lastPushAt: null,
  lastPullAt: null,
  cloudLastOkAt: null,
  cloudError: null,
  blockedReason: null,
  environment: "dev",
  syncEnabled: false,
};
const chrome: Chrome = {
  health,
  now: 0,
  host: "writer.example.test",
  liveLinkCount: 0,
  pausedLinkCount: 0,
  trashCount: 0,
  trashedPending: [],
};

async function html(node: { toString(): string | Promise<string> }): Promise<string> {
  return await node.toString();
}
/** The opening tag of the first element matching `pattern` (an attribute it carries). */
function tag(markup: string, pattern: string): string {
  const at = markup.indexOf(pattern);
  if (at < 0) return "";
  const start = markup.lastIndexOf("<", at);
  return markup.slice(start, markup.indexOf(">", at) + 1);
}
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

describe("Find (NAV-02)", () => {
  it("is a labelled dialog holding a combobox, its listbox and one status", async () => {
    const dialog = await html(FindDialog({}));
    const root = tag(dialog, 'id="find"');
    expect(root.startsWith("<dialog")).toBe(true);
    expect(root).toContain('class="find"');
    expect(root).toContain('aria-labelledby="find-title"');
    expect(root).toContain('closedby="any"');
    expect(dialog).toMatch(/<h2 id="find-title"[^>]*>\s*Find a collection\s*<\/h2>/);

    const input = tag(dialog, 'role="combobox"');
    expect(input.startsWith('<input type="search" name="q"')).toBe(true);
    for (const attribute of [
      'aria-controls="find-suggest"',
      'aria-expanded="false"',
      'aria-autocomplete="list"',
      "autofocus",
      'enterkeyhint="search"',
      'autocapitalize="none"',
      'autocomplete="off"',
      'spellcheck="false"',
      'aria-label="Find a collection, or paste a URL or ID"',
      'placeholder="Find a collection, or paste a URL or ID"',
    ])
      expect(input).toContain(attribute);
    expect(input).not.toContain("aria-activedescendant");

    const form = tag(dialog, "data-find");
    expect(form).toMatch(/^<form class="find-form" role="search" action="\/" method="get"/);
    expect(form).toContain("data-search");
    const list = tag(dialog, 'id="find-suggest"');
    expect(list).toContain('role="listbox"');
    expect(list).toContain('aria-label="Suggestions"');
    expect(list).toMatch(/\shidden/);
    expect(count(dialog, 'role="status"')).toBe(1);
    expect(dialog).toContain("data-search-status");

    const cancel = tag(dialog, 'class="find-cancel"');
    expect(cancel).toContain('commandfor="find"');
    expect(cancel).toContain('command="close"');
    expect(dialog).toContain(">Cancel</button>");
    expect(dialog.replace(/<[^>]+>/g, "")).toContain(
      "↑↓ move · ↵ open · ⇧↵ all results · Paste a Waypoint URL or ID to jump to it",
    );
  });

  it("offers the four filter tokens as toggle buttons, in order", async () => {
    const dialog = await html(FindDialog({}));
    expect(tag(dialog, 'class="find-tokens"')).toContain('role="group" aria-label="Filters"');
    const buttons = [...dialog.matchAll(/<button[^>]*data-token="([^"]+)"[^>]*>/g)];
    expect(buttons.map(([, token]) => token)).toEqual([
      "is:public",
      "is:failed",
      "in:trash",
      "project:",
    ]);
    for (const [button] of buttons) {
      expect(button).toContain('type="button"');
      expect(button).toContain('aria-pressed="false"');
    }
  });

  it("shows the Files row only on collection pages", async () => {
    expect(await html(FindDialog({}))).not.toContain("Looking for a file");
    const dialog = await html(FindDialog({ findIn: "Webhook idempotency research" }));
    expect(dialog).toContain("Looking for a file in <b>Webhook idempotency research</b>?");
    expect(dialog).toMatch(
      /<a href="\?panel=files"[^>]*>Open Files<span aria-hidden="true"> ›<\/span><\/a>/,
    );
  });

  it("FindButton opens Find and names its key", async () => {
    const button = await html(FindButton({}));
    expect(button.startsWith('<button type="button" class="iconbtn"')).toBe(true);
    for (const attribute of [
      'aria-label="Find"',
      'aria-keyshortcuts="/"',
      'title="Find  /"',
      'commandfor="find"',
      'command="show-modal"',
      '<svg class="ic lg"',
    ])
      expect(button).toContain(attribute);
    expect(await html(FindButton({ class: "show-sm" }))).toContain('class="iconbtn show-sm"');
  });

  it("is in every Layout, and the viewport resizes content for the keyboard", async () => {
    const page = await html(
      Layout({ title: "Recent", chrome, bar: null, children: null, page: "recent" }),
    );
    const head = page.slice(0, page.indexOf("</head>"));
    expect(tag(head, 'name="viewport"')).toContain("interactive-widget=resizes-content");
    expect(count(page, 'id="find"')).toBe(1);
    expect(page).not.toContain("Looking for a file");
    const collection = await html(
      Layout({
        title: "Webhooks",
        chrome,
        bar: null,
        children: null,
        page: "collection",
        findIn: "Webhooks",
      }),
    );
    expect(collection).toContain("Looking for a file in <b>Webhooks</b>?");
  });
});
