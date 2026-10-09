// The one keymap: every keyboard shortcut, its words and its scope. The shortcuts dialog renders
// it, client/keys.ts dispatches through it and tooltips name keys from it; tests/keymap.test.ts
// keeps the handlers in step. Pure (no DOM, no Node): the server pages and the client bundles
// both import it, so keep it dependency-free and small.

export type KeyScope = "all" | "collection" | "changes" | "gallery" | "find";
export type KeyCommand =
  | "find"
  | "go-recent"
  | "go-links"
  | "go-trash"
  | "go-status"
  | "keys"
  | "escape"
  | "panel"
  | "files"
  | "history"
  | "older"
  | "newer"
  | "changes"
  | "copy-latest"
  | "copy-pinned"
  | "copy-handoff"
  | "share"
  | "next-change"
  | "prev-change"
  | "changes-done"
  | "find-prev"
  | "find-next"
  | "find-open"
  | "find-all"
  | "image-prev"
  | "image-next"
  | "gallery-done";

/** Keys use KeyboardEvent.key notation: a chord is one space-separated string ("g h"), Shift +
 *  letter is the upper-case letter ("C") and Shift + anything else is written "Shift+Enter". */
export interface KeyBinding {
  readonly keys: readonly string[];
  /** May contain the literal "#N" (the current revision). */
  readonly label: string;
  /** May contain "#N" (the current revision) or "#L" (the latest revision). */
  readonly note?: string;
  /** Short name for tooltips. */
  readonly title?: string;
  readonly scope: KeyScope;
  /** The entry's command (the first key's). */
  readonly command: KeyCommand;
  /** One per key, for pairs. */
  readonly commands?: readonly KeyCommand[];
  /** Works with single-key shortcuts turned off. */
  readonly always?: true;
}

/** In dialog order: the order inside a scope is the order of its rows. */
export const KEYMAP: readonly KeyBinding[] = [
  {
    scope: "all",
    keys: ["/"],
    label: "Find a collection, or paste a URL or ID",
    title: "Find",
    command: "find",
    always: true,
  },
  { scope: "all", keys: ["g h"], label: "Recent", title: "Recent", command: "go-recent" },
  {
    scope: "all",
    keys: ["g l"],
    label: "Public links",
    title: "Public links",
    command: "go-links",
  },
  { scope: "all", keys: ["g t"], label: "Trash", title: "Trash", command: "go-trash" },
  { scope: "all", keys: ["g s"], label: "Status", title: "Status", command: "go-status" },
  {
    scope: "all",
    keys: ["?"],
    label: "This list",
    title: "Keyboard shortcuts",
    command: "keys",
    always: true,
  },
  {
    scope: "all",
    keys: ["Escape"],
    label: "Close the open menu, sheet or dialog",
    command: "escape",
    always: true,
  },
  {
    scope: "collection",
    keys: ["."],
    label: "Show or hide Files and history",
    title: "Files and history",
    command: "panel",
  },
  {
    scope: "collection",
    keys: ["f"],
    label: "Files, then type to filter",
    title: "Files",
    command: "files",
  },
  {
    scope: "collection",
    keys: ["h"],
    label: "History",
    note: "or the #N pill",
    title: "History",
    command: "history",
  },
  {
    scope: "collection",
    keys: ["[", "]"],
    label: "Parent or child revision on this line",
    note: "At the end of a branch: End of this branch. Latest is #L",
    command: "older",
    commands: ["older", "newer"],
  },
  {
    scope: "collection",
    keys: ["d"],
    label: "Changes from the parent",
    title: "Changes",
    command: "changes",
  },
  {
    scope: "collection",
    keys: ["c"],
    label: "Copy tailnet link to latest",
    command: "copy-latest",
  },
  {
    scope: "collection",
    keys: ["C"],
    label: "Copy tailnet link to this revision",
    command: "copy-pinned",
  },
  {
    scope: "collection",
    keys: ["a"],
    label: "Copy handoff block for an agent",
    command: "copy-handoff",
  },
  { scope: "collection", keys: ["s"], label: "Share…", title: "Share", command: "share" },
  {
    scope: "changes",
    keys: ["j", "k"],
    label: "Next or previous change",
    note: "or Previous / Next by the view switch",
    command: "next-change",
    commands: ["next-change", "prev-change"],
  },
  {
    scope: "changes",
    keys: ["Escape"],
    label: "Done: back to #N",
    title: "Done",
    command: "changes-done",
    always: true,
  },
  {
    scope: "find",
    keys: ["ArrowUp", "ArrowDown"],
    label: "Move through results",
    command: "find-prev",
    commands: ["find-prev", "find-next"],
    always: true,
  },
  {
    scope: "find",
    keys: ["Enter"],
    label: "Open the result",
    command: "find-open",
    always: true,
  },
  {
    scope: "find",
    keys: ["Shift+Enter"],
    label: "All results for what you typed",
    command: "find-all",
    always: true,
  },
  {
    scope: "gallery",
    keys: ["ArrowLeft", "ArrowRight"],
    label: "Previous or next image",
    command: "image-prev",
    commands: ["image-prev", "image-next"],
    always: true,
  },
  {
    scope: "gallery",
    keys: ["Escape"],
    label: "Done",
    title: "Done",
    command: "gallery-done",
    always: true,
  },
];

export const SCOPE_HEADINGS: Readonly<Record<KeyScope, string>> = {
  all: "Everywhere",
  collection: "In this collection",
  changes: "On the Changes page",
  find: "In Find",
  gallery: "In the gallery viewer",
};

/** The scopes active on a page (body[data-page]). "find" applies only inside the Find combobox. */
export function scopesFor(page: string | undefined): readonly KeyScope[] {
  if (page === "collection") return ["all", "collection"];
  if (page === "changes") return ["all", "collection", "changes"];
  if (page === "gallery") return ["all", "collection", "gallery"];
  return ["all"];
}

export interface KeyMatch {
  binding: KeyBinding;
  command: KeyCommand;
  key: string;
}
interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

function matches(key: string, event: KeyEventLike, chord: string | undefined): boolean {
  const space = key.indexOf(" ");
  if (space >= 0) return chord === key.slice(0, space) && event.key === key.slice(space + 1);
  if (chord !== undefined) return false;
  if (key === "Shift+Enter") return event.key === "Enter" && event.shiftKey === true;
  if (key === "Enter") return event.key === "Enter" && !event.shiftKey;
  // Case is the Shift signal: "C" matches only event.key "C".
  return key === event.key;
}

/** The first entry, searching the scopes in order, whose key is this event (after `chord`, the
 *  pending chord prefix, when given). Meta, Ctrl and Alt never match. */
export function matchKey(
  event: KeyEventLike,
  scope: KeyScope | readonly KeyScope[],
  chord?: string,
): KeyMatch | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const scopes: readonly KeyScope[] = typeof scope === "string" ? [scope] : scope;
  for (const current of scopes)
    for (const binding of KEYMAP) {
      if (binding.scope !== current) continue;
      const index = binding.keys.findIndex((key) => matches(key, event, chord));
      const key = binding.keys[index];
      if (key === undefined) continue;
      return { binding, command: binding.commands?.[index] ?? binding.command, key };
    }
  return undefined;
}

function commandsOf(binding: KeyBinding): readonly KeyCommand[] {
  return binding.commands ?? [binding.command];
}
/** The entry that binds `command`; throws for an unknown command. */
export function bindingFor(command: KeyCommand): KeyBinding {
  const binding = KEYMAP.find((entry) => commandsOf(entry).includes(command));
  if (!binding) throw new Error(`No key for ${command}`);
  return binding;
}
/** That command's own key (for a pair, the key at the command's position). */
export function keyFor(command: KeyCommand): string {
  const binding = bindingFor(command);
  const key = binding.keys[commandsOf(binding).indexOf(command)];
  if (key === undefined) throw new Error(`No key for ${command}`);
  return key;
}

const LABELS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  "Shift+Enter": "⇧↵",
};
/** How a key reads on a keycap: "Esc", "←", "⇧↵", "⇧C". */
export function keyLabel(key: string): string {
  const label = LABELS[key];
  if (label !== undefined) return label;
  return /^[A-Z]$/.test(key) ? `⇧${key}` : key;
}
/** One keycap per key of a chord: "g h" → ["g", "h"]. */
export function keycaps(key: string): string[] {
  return key.split(" ").map(keyLabel);
}
/** The tooltip name with its key: "History  h", "Status  g s". */
export function keyTitle(command: KeyCommand): string {
  const binding = bindingFor(command);
  return `${binding.title ?? binding.label}  ${keycaps(keyFor(command)).join(" ")}`;
}

function ariaToken(key: string): string | undefined {
  if (key.includes(" ")) return undefined;
  return /^[A-Z]$/.test(key) ? `Shift+${key}` : key;
}
/** The aria-keyshortcuts tokens for an entry's keys; chords have none. */
export function ariaKeys(binding: KeyBinding): string[] {
  return binding.keys.flatMap((key) => ariaToken(key) ?? []);
}
/** The aria-keyshortcuts value for a command's own key, or undefined for a chord. */
export function ariaKeyshortcuts(command: KeyCommand): string | undefined {
  return ariaToken(keyFor(command));
}
