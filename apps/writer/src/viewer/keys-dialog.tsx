/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import { KEYMAP, keycaps, SCOPE_HEADINGS, type KeyBinding, type KeyScope } from "./keymap.ts";

export interface Grouping {
  /** The page's own groups, in display order: exactly scopesFor(page), reordered. */
  readonly shown: readonly KeyScope[];
  /** The other groups, collapsed under `summary`. */
  readonly collapsed: readonly KeyScope[];
  readonly summary: string;
}
/** Which groups each page (body[data-page]) shows open; tests/keys-dialog.test.ts keeps this in
 *  step with scopesFor. */
const KEY_GROUPS: Readonly<Record<"changes" | "gallery" | "collection" | "other", Grouping>> = {
  changes: {
    shown: ["changes", "collection", "all"],
    collapsed: ["find", "gallery"],
    summary: "Inside Find and the gallery",
  },
  gallery: {
    shown: ["gallery", "collection", "all"],
    collapsed: ["changes", "find"],
    summary: "Other pages and Find",
  },
  collection: {
    shown: ["collection", "all"],
    collapsed: ["changes", "gallery", "find"],
    summary: "Other pages, Find and the gallery",
  },
  other: {
    shown: ["all"],
    collapsed: ["collection", "changes", "gallery", "find"],
    summary: "Other pages, Find and the gallery",
  },
};
export function keyGroups(page: string | undefined): Grouping {
  return page === "changes" || page === "gallery" || page === "collection"
    ? KEY_GROUPS[page]
    : KEY_GROUPS.other;
}

/** "#N" (with a leading "the") and "#L" become spans bindKeysDialog fills with the numbers; the
 *  text without script reads "the revision" / "the newest revision". */
function numbered(text: string): Child[] {
  const parts: Child[] = [];
  let last = 0;
  for (const found of text.matchAll(/(?:the )?#N|#L/g)) {
    parts.push(text.slice(last, found.index));
    parts.push(
      <span data-keys-n={found[0]}>
        {found[0] === "#L" ? "the newest revision" : "the revision"}
      </span>,
    );
    last = found.index + found[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

function Row(props: { binding: KeyBinding }) {
  const caps = props.binding.keys.flatMap(keycaps);
  return (
    <div>
      <dt>
        {caps.map((cap, index) => (
          <>
            {index ? " " : ""}
            <kbd>{cap}</kbd>
          </>
        ))}
      </dt>
      <dd>
        {numbered(props.binding.label)}
        {props.binding.note === undefined ? null : (
          <>
            {" "}
            <small>{numbered(props.binding.note)}</small>
          </>
        )}
      </dd>
    </div>
  );
}

function Group(props: { scope: KeyScope }) {
  const { scope } = props;
  return (
    <section class="kg" aria-labelledby={`kg-${scope}`}>
      <h3 id={`kg-${scope}`}>
        {SCOPE_HEADINGS[scope]}
        {scope === "collection" ? (
          <>
            {" "}
            <span>collection, Changes and Gallery pages</span>
          </>
        ) : null}
      </h3>
      <dl>
        {KEYMAP.filter((binding) => binding.scope === scope).map((binding) => (
          <Row binding={binding} />
        ))}
      </dl>
    </section>
  );
}

/** The shortcuts list, from the one keymap: this page's groups open (in two columns from 700 px),
 *  the rest collapsed; the opt-out stays in the pinned footer, and focus starts on Close. */
export function KeysDialog(props: { page: string }) {
  const { shown, collapsed, summary } = keyGroups(props.page);
  const own = shown.filter((scope) => scope !== "all");
  const other = (
    <details class="kother">
      <summary>{summary}</summary>
      {collapsed.map((scope) => (
        <Group scope={scope} />
      ))}
    </details>
  );
  return (
    <dialog class="dlg keys" id="keys" aria-labelledby="keys-title">
      <div class="bd">
        <h2 id="keys-title">Keyboard shortcuts</h2>
        <div class="kcols">
          {own.length ? (
            <>
              <div class="kcol">
                {own.map((scope) => (
                  <Group scope={scope} />
                ))}
              </div>
              <div class="kcol">
                <Group scope="all" />
                {other}
              </div>
            </>
          ) : (
            <>
              <div class="kcol">
                <Group scope="all" />
              </div>
              <div class="kcol">{other}</div>
            </>
          )}
        </div>
        <p class="muted small knote">
          Keys work when focus is on Waypoint, not inside a document: press <kbd>Esc</kbd> in the
          document first. Every key here also has a button or menu item.
        </p>
      </div>
      <form method="dialog" class="ft">
        <label class="check">
          <input type="checkbox" data-keys-off />
          {" Turn off single-key shortcuts "}
          <small class="muted">· / ? and Esc keep working</small>
        </label>
        <button class="btn primary" value="close" autofocus>
          Close
        </button>
      </form>
    </dialog>
  );
}
