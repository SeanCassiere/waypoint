import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ariaKeys,
  ariaKeyshortcuts,
  bindingFor,
  KEYMAP,
  keycaps,
  keyLabel,
  keyTitle,
  matchKey,
  scopesFor,
  SCOPE_HEADINGS,
  type KeyBinding,
  type KeyCommand,
  type KeyScope,
} from "../src/viewer/keymap.ts";
import { endOfBranch } from "../src/viewer/lineage.ts";
import { PENDING_HANDLERS } from "./keymap-pending.ts";

type Row = [
  scope: KeyScope,
  keys: string[],
  label: string,
  note: string | undefined,
  title: string | undefined,
  commands: KeyCommand[],
  always: boolean,
];
// The agreed list (FD2's table), in dialog order.
const TABLE: Row[] = [
  ["all", ["/"], "Find a collection, or paste a URL or ID", undefined, "Find", ["find"], true],
  ["all", ["g h"], "Recent", undefined, "Recent", ["go-recent"], false],
  ["all", ["g l"], "Public links", undefined, "Public links", ["go-links"], false],
  ["all", ["g t"], "Trash", undefined, "Trash", ["go-trash"], false],
  ["all", ["g s"], "Status", undefined, "Status", ["go-status"], false],
  ["all", ["?"], "This list", undefined, "Keyboard shortcuts", ["keys"], true],
  [
    "all",
    ["Escape"],
    "Close the open menu, sheet or dialog",
    undefined,
    undefined,
    ["escape"],
    true,
  ],
  [
    "collection",
    ["."],
    "Show or hide Files and history",
    undefined,
    "Files and history",
    ["panel"],
    false,
  ],
  ["collection", ["f"], "Files, then type to filter", undefined, "Files", ["files"], false],
  ["collection", ["h"], "History", "or the #N pill", "History", ["history"], false],
  [
    "collection",
    ["[", "]"],
    "Parent or child revision on this line",
    "At the end of a branch: End of this branch. Latest is #L",
    undefined,
    ["older", "newer"],
    false,
  ],
  ["collection", ["d"], "Changes from the parent", undefined, "Changes", ["changes"], false],
  [
    "collection",
    ["c"],
    "Copy tailnet link to latest",
    undefined,
    undefined,
    ["copy-latest"],
    false,
  ],
  [
    "collection",
    ["C"],
    "Copy tailnet link to this revision",
    undefined,
    undefined,
    ["copy-pinned"],
    false,
  ],
  [
    "collection",
    ["a"],
    "Copy handoff block for an agent",
    undefined,
    undefined,
    ["copy-handoff"],
    false,
  ],
  ["collection", ["s"], "Share…", undefined, "Share", ["share"], false],
  [
    "changes",
    ["j", "k"],
    "Next or previous change",
    "or Previous / Next by the view switch",
    undefined,
    ["next-change", "prev-change"],
    false,
  ],
  ["changes", ["Escape"], "Done: back to #N", undefined, "Done", ["changes-done"], true],
  [
    "find",
    ["ArrowUp", "ArrowDown"],
    "Move through results",
    undefined,
    undefined,
    ["find-prev", "find-next"],
    true,
  ],
  ["find", ["Enter"], "Open the result", undefined, undefined, ["find-open"], true],
  [
    "find",
    ["Shift+Enter"],
    "All results for what you typed",
    undefined,
    undefined,
    ["find-all"],
    true,
  ],
  [
    "gallery",
    ["ArrowLeft", "ArrowRight"],
    "Previous or next image",
    undefined,
    undefined,
    ["image-prev", "image-next"],
    true,
  ],
  ["gallery", ["Escape"], "Done", undefined, "Done", ["gallery-done"], true],
];
function entry([scope, keys, label, note, title, commands, always]: Row): KeyBinding {
  const [command] = commands;
  if (!command) throw new Error("A row needs a command");
  return {
    scope,
    keys,
    label,
    ...(note === undefined ? {} : { note }),
    ...(title === undefined ? {} : { title }),
    command,
    ...(commands.length > 1 ? { commands } : {}),
    ...(always ? { always: true as const } : {}),
  };
}

function keysIn(scopes: KeyScope[]): string[] {
  return KEYMAP.filter((binding) => scopes.includes(binding.scope)).flatMap(
    (binding) => binding.keys,
  );
}

describe("KEYMAP", () => {
  it("is the agreed 23-row list, in order", () => {
    expect(KEYMAP).toStrictEqual(TABLE.map(entry));
    expect(KEYMAP).toHaveLength(23);
  });

  it("describes the end of a branch in the toast's own words", () => {
    expect(bindingFor("older").note?.endsWith(endOfBranch(7).replace("#7", "#L"))).toBe(true);
  });

  it("never binds one key twice where both could fire", () => {
    const duplicates = (
      [["all", "collection"], ["changes"], ["gallery"], ["find"]] satisfies KeyScope[][]
    ).flatMap((scopes) => keysIn(scopes).filter((key, index, keys) => keys.indexOf(key) !== index));
    expect(duplicates).toEqual([]);
    expect(
      KEYMAP.flatMap((binding, index) => (binding.keys.includes("Escape") ? [index + 1] : [])),
    ).toEqual([7, 18, 23]);
  });

  it("gives a pair one command per key, the first being the entry's", () => {
    const pairs = KEYMAP.filter((binding) => binding.commands !== undefined);
    expect(pairs.map((binding) => binding.commands?.length)).toEqual(
      pairs.map((binding) => binding.keys.length),
    );
    expect(pairs.map((binding) => binding.command)).toEqual(
      pairs.map((binding) => binding.commands?.[0]),
    );
  });

  it("has a heading for every scope", () => {
    expect(SCOPE_HEADINGS).toStrictEqual({
      all: "Everywhere",
      collection: "In this collection",
      changes: "On the Changes page",
      find: "In Find",
      gallery: "In the gallery viewer",
    });
  });
});

describe("scopesFor", () => {
  it("maps each page to its scopes", () => {
    expect(scopesFor("collection")).toEqual(["all", "collection"]);
    expect(scopesFor("changes")).toEqual(["all", "collection", "changes"]);
    expect(scopesFor("gallery")).toEqual(["all", "collection", "gallery"]);
    for (const page of ["recent", "links", "status", undefined])
      expect(scopesFor(page)).toEqual(["all"]);
  });
});

const commandOf = (...args: Parameters<typeof matchKey>): KeyCommand | undefined =>
  matchKey(...args)?.command;

describe("matchKey", () => {
  it("finds the first entry for a key in the given scopes", () => {
    expect(commandOf({ key: "/" }, ["all"])).toBe("find");
    expect(commandOf({ key: "h" }, ["all"])).toBeUndefined();
    expect(commandOf({ key: "h" }, ["all", "collection"])).toBe("history");
    expect(commandOf({ key: "Escape" }, ["all", "collection"])).toBe("escape");
    expect(commandOf({ key: "Escape" }, ["changes", "all"])).toBe("changes-done");
  });
  it("matches chords only after their prefix", () => {
    expect(commandOf({ key: "h" }, ["all", "collection"], "g")).toBe("go-recent");
    expect(commandOf({ key: "s" }, ["all", "collection"], "g")).toBe("go-status");
    expect(commandOf({ key: "s" }, ["all", "collection"])).toBe("share");
    expect(commandOf({ key: "x" }, ["all", "collection"], "g")).toBeUndefined();
    expect(commandOf({ key: "g" }, ["all", "collection"])).toBeUndefined();
  });
  it("reads Shift from the key's case, and Shift+Enter from shiftKey", () => {
    expect(commandOf({ key: "C", shiftKey: true }, ["all", "collection"])).toBe("copy-pinned");
    expect(commandOf({ key: "c" }, ["all", "collection"])).toBe("copy-latest");
    expect(commandOf({ key: "]" }, ["all", "collection"])).toBe("newer");
    expect(commandOf({ key: "[" }, "collection")).toBe("older");
    expect(commandOf({ key: "Enter", shiftKey: true }, "find")).toBe("find-all");
    expect(commandOf({ key: "Enter" }, "find")).toBe("find-open");
    expect(commandOf({ key: "k" }, "changes")).toBe("prev-change");
    expect(commandOf({ key: "j" }, "changes")).toBe("next-change");
    expect(commandOf({ key: "ArrowRight" }, "gallery")).toBe("image-next");
  });
  it("never matches with Meta, Ctrl or Alt", () => {
    expect(commandOf({ key: "s", ctrlKey: true }, ["all", "collection"])).toBeUndefined();
    expect(commandOf({ key: "/", metaKey: true }, ["all"])).toBeUndefined();
    expect(commandOf({ key: "h", altKey: true }, ["all"], "g")).toBeUndefined();
  });
  it("returns the entry and the key", () => {
    expect(matchKey({ key: "]" }, "collection")).toStrictEqual({
      binding: bindingFor("newer"),
      command: "newer",
      key: "]",
    });
  });
});

describe("display helpers", () => {
  it("names a command with its keycaps", () => {
    expect(keyTitle("history")).toBe("History  h");
    expect(keyTitle("files")).toBe("Files  f");
    expect(keyTitle("find")).toBe("Find  /");
    expect(keyTitle("share")).toBe("Share  s");
    expect(keyTitle("go-status")).toBe("Status  g s");
    expect(keyTitle("copy-pinned")).toBe("Copy tailnet link to this revision  ⇧C");
    expect(keyTitle("newer")).toBe("Parent or child revision on this line  ]");
  });
  it("labels keys as keycaps", () => {
    expect(keyLabel("Escape")).toBe("Esc");
    expect(keyLabel("ArrowLeft")).toBe("←");
    expect(keyLabel("ArrowUp")).toBe("↑");
    expect(keyLabel("Shift+Enter")).toBe("⇧↵");
    expect(keyLabel("Enter")).toBe("↵");
    expect(keyLabel("C")).toBe("⇧C");
    expect(keyLabel("/")).toBe("/");
    expect(keyLabel("g h")).toBe("g h");
    expect(keycaps("g h")).toEqual(["g", "h"]);
    expect(keycaps("Escape")).toEqual(["Esc"]);
    expect(keycaps("C")).toEqual(["⇧C"]);
    expect(keycaps("ArrowLeft")).toEqual(["←"]);
    expect(keycaps("Shift+Enter")).toEqual(["⇧↵"]);
  });
  it("gives aria-keyshortcuts tokens, none for chords", () => {
    expect(ariaKeys(bindingFor("escape"))).toEqual(["Escape"]);
    expect(ariaKeys(bindingFor("image-prev"))).toEqual(["ArrowLeft", "ArrowRight"]);
    expect(ariaKeys(bindingFor("find-all"))).toEqual(["Shift+Enter"]);
    expect(ariaKeys(bindingFor("copy-pinned"))).toEqual(["Shift+C"]);
    expect(ariaKeys(bindingFor("go-recent"))).toEqual([]);
    expect(ariaKeyshortcuts("find")).toBe("/");
    expect(ariaKeyshortcuts("copy-pinned")).toBe("Shift+C");
    expect(ariaKeyshortcuts("escape")).toBe("Escape");
    expect(ariaKeyshortcuts("newer")).toBe("]");
    expect(ariaKeyshortcuts("image-prev")).toBe("ArrowLeft");
    expect(ariaKeyshortcuts("find-all")).toBe("Shift+Enter");
    expect(ariaKeyshortcuts("go-recent")).toBeUndefined();
  });
  it("throws for a command it doesn't know", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately not a command.
    expect(() => bindingFor("nope" as KeyCommand)).toThrow("No key for nope");
  });
});

// The registry and the handlers, read as text: the client modules touch the DOM and can't be
// imported here. Widget keys (ARIA roving and Esc inside menus.ts, panel.ts, share.ts and
// frame-sync.ts) are not shortcuts and are out of this check by design.
const clientDir = fileURLToPath(new URL("../src/client/", import.meta.url));
const clientSources = new Map(
  readdirSync(clientDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => [file, readFileSync(join(clientDir, file), "utf8")]),
);
const SHORTCUT_MODULES = ["keys.ts", "changes-nav.ts", "gallery.ts", "search.ts"];

/** Some client module names the command as a quoted literal (a case label, an onCommand call). */
const handled = (command: KeyCommand): boolean =>
  [...clientSources.values()].some((source) => source.includes(`"${command}"`));

describe("the registry and the handlers", () => {
  const commands = [...new Set(KEYMAP.flatMap((binding) => binding.commands ?? [binding.command]))];

  it("has a handler for every registered command, or lists it as pending", () => {
    const missing = commands.filter(
      (command) => !handled(command) && !PENDING_HANDLERS.includes(command),
    );
    expect(missing).toEqual([]);
  });

  it("lists no pending command that already has a handler (shrink-only)", () => {
    expect(PENDING_HANDLERS.filter((command) => handled(command))).toEqual([]);
    expect(PENDING_HANDLERS.filter((command) => !commands.includes(command))).toEqual([]);
  });

  it("registers every key a shortcut module compares", () => {
    const registered = new Set(["g", ...KEYMAP.flatMap((binding) => binding.keys)]);
    const compared = SHORTCUT_MODULES.flatMap((file) => {
      const source = clientSources.get(file);
      if (source === undefined) throw new Error(`Missing src/client/${file}`);
      const keys = [...source.matchAll(/\.key\s*[!=]==?\s*"([^"]+)"/g)].map((found) => found[1]);
      const lists = [
        ...source.matchAll(/\[\s*"[^"]+"(?:\s*,\s*"[^"]+")*\s*\]\.includes\(\s*event\.key/g),
      ].flatMap((found) => [...found[0].matchAll(/"([^"]+)"/g)].map((key) => key[1]));
      return [...keys, ...lists].map((key) => `${file}: ${key ?? ""}`);
    });
    expect(compared.length).toBeGreaterThan(0);
    expect(compared.filter((found) => !registered.has(found.split(": ")[1] ?? ""))).toEqual([]);
  });
});
