/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import type { Health } from "../health.js";
import { clientAsset, cssAsset } from "./assets.js";
import { HealthPill, HealthPopover, LogoMark } from "./components.js";

const favicon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#1b1a17"/><path d="M14 20l10 26 8-17 8 17 10-26" fill="none" stroke="#fcfbf9" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

/** Per-request data every page needs for its chrome (bar, health pill and popover). */
export interface Chrome {
  health: Health;
  now: number;
  host: string;
}

export function Layout(props: {
  title: string;
  chrome: Chrome;
  bar: Child;
  children: Child;
  page: string;
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{props.title === "Waypoint" ? "Waypoint" : `${props.title} · Waypoint`}</title>
        <link rel="icon" href={favicon} />
        <link rel="stylesheet" href={cssAsset.url} />
      </head>
      <body data-page={props.page}>
        <a class="skip" href="#main">
          {props.page === "collection" ? "Skip to document" : "Skip to content"}
        </a>
        {props.bar}
        {props.children}
        <HealthPopover
          health={props.chrome.health}
          now={props.chrome.now}
          host={props.chrome.host}
        />
        <KeysDialog />
        <ConfirmDialog />
        <div class="toast" role="status" aria-live="polite" data-toast hidden />
        <script src={clientAsset.url} defer />
      </body>
    </html>
  );
}

export function HomeBar(props: { chrome: Chrome; q?: string | undefined }) {
  return (
    <header class="bar">
      <a class="logo" href="/" aria-label="Waypoint, Recent">
        <LogoMark />
        <span>Waypoint</span>
      </a>
      <form class="search hide-sm" role="search" action="/" method="get" data-search>
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          name="q"
          value={props.q ?? ""}
          placeholder="Search, or paste a URL or ID"
          aria-label="Search, or paste a URL or ID"
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded="false"
          aria-controls="suggest"
          aria-autocomplete="list"
        />
        <kbd aria-hidden="true">/</kbd>
        <ul class="suggest" id="suggest" role="listbox" aria-label="Suggestions" hidden />
      </form>
      <a
        class="iconbtn show-sm"
        href={props.q ? `/?q=${encodeURIComponent(props.q)}` : "/?q="}
        aria-label="Search"
      >
        ⌕
      </a>
      <HealthPill health={props.chrome.health} />
      <a class="iconbtn hide-sm" href="/trash" title="Trash" aria-label="Trash">
        ⌫
      </a>
      <button
        type="button"
        class="iconbtn"
        popovertarget="home-more"
        aria-haspopup="menu"
        aria-label="More"
        title="Public links · Connect an agent · Status · Shortcuts"
      >
        ⋯
      </button>
      <div id="home-more" class="menu" popover="auto" role="menu" aria-label="More">
        <a class="mi" role="menuitem" href="/links">
          <span aria-hidden="true">◍</span>
          <span>Public links</span>
        </a>
        <a class="mi" role="menuitem" href="/mcp">
          <span aria-hidden="true">⚯</span>
          <span>Connect an agent</span>
        </a>
        <a class="mi" role="menuitem" href="/status">
          <span aria-hidden="true">◉</span>
          <span>Status</span>
          <kbd>g s</kbd>
        </a>
        <a class="mi show-sm" role="menuitem" href="/trash">
          <span aria-hidden="true">⌫</span>
          <span>Trash</span>
        </a>
        <button type="button" class="mi" role="menuitem" commandfor="keys" command="show-modal">
          <span aria-hidden="true">?</span>
          <span>Keyboard shortcuts</span>
          <kbd>?</kbd>
        </button>
      </div>
    </header>
  );
}

function KeysDialog() {
  const keys: [string, string][] = [
    ["/", "Search, or paste a URL or ID"],
    ["g h", "Go to Recent"],
    ["g s", "Go to Status"],
    [".", "Show or hide the side panel"],
    ["f", "Files tab, then type to filter"],
    ["h", "History tab"],
    ["[  ]", "Previous or next revision"],
    ["d", "Changes in this revision (vs. its parent)"],
    ["c", "Copy link to latest"],
    ["⇧C", "Copy link to this revision"],
    ["a", "Copy handoff block for an agent"],
    ["s", "Share…"],
    ["j  k", "Next or previous change (Changes page)"],
    ["Esc", "Close panel, menu, or compare"],
    ["?", "This help"],
  ];
  return (
    <dialog class="dlg narrow" id="keys" aria-labelledby="keys-title">
      <div class="bd">
        <h2 id="keys-title">Keyboard shortcuts</h2>
        <div class="keys">
          {keys.map(([key, label]) => (
            <>
              <kbd>{key}</kbd>
              <span>{label}</span>
            </>
          ))}
        </div>
        <label class="check">
          <input type="checkbox" data-keys-off />
          Disable single-key shortcuts
        </label>
        <p class="muted small">
          Shortcuts work while focus is on Waypoint itself. Inside a document, press <kbd>
            Esc
          </kbd>{" "}
          first. Every shortcut has a button or menu item too.
        </p>
      </div>
      <form method="dialog" class="ft">
        <button class="btn primary" value="close">
          Close
        </button>
      </form>
    </dialog>
  );
}

/** One generic confirmation dialog; the client fills it for Drop, Revoke, Trash and Purge. */
function ConfirmDialog() {
  return (
    <dialog
      class="dlg narrow"
      id="confirm"
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
    >
      <div class="band" data-confirm-band hidden>
        <span class="bang" aria-hidden="true">
          !
        </span>
        <div>
          <h2 id="confirm-band-title" data-confirm-band-title />
          <p data-confirm-band-body />
        </div>
      </div>
      <div class="bd">
        <h2 id="confirm-title" data-confirm-title />
        <div id="confirm-body" data-confirm-body />
        <label class="fl" data-confirm-typed hidden>
          <span data-confirm-typed-label>Type the collection's title to confirm</span>
          <input
            class="confirm-input"
            autocomplete="off"
            spellcheck={false}
            aria-describedby="confirm-hint"
          />
          <small id="confirm-hint" data-confirm-hint />
        </label>
      </div>
      <p class="alert" role="alert" data-confirm-error />
      <form method="dialog" class="ft">
        <span class="grow" data-confirm-note />
        <button class="btn" value="cancel" data-confirm-cancel>
          Cancel
        </button>
        <button type="button" class="btn" data-confirm-alt hidden />
        <button type="button" class="btn danger" data-confirm-ok>
          OK
        </button>
      </form>
    </dialog>
  );
}

export function NotFoundBody(props: {
  path: string;
  latestHref?: string | undefined;
  message?: Child;
}) {
  return (
    <main class="wrap narrow notfound" id="main">
      <b>Not found</b>
      <p class="muted">
        {props.message ?? (
          <>
            No collection, revision, or file matches <span class="mono">{props.path}</span>.
          </>
        )}
      </p>
      <div class="btns">
        {props.latestHref ? (
          <a class="btn primary" href={props.latestHref}>
            Open the latest revision
          </a>
        ) : null}
        <a class="btn" href="/">
          Back to Recent
        </a>
      </div>
    </main>
  );
}
