/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import type { Health } from "../health.ts";
import { clientAsset, cssAsset, faviconAsset, pagesAsset } from "./assets.ts";
import { HealthPill, HealthPopover, LogoMark } from "./components.tsx";
import { plural } from "./format.ts";
import { ariaKeyshortcuts, keycaps, keyFor, keyTitle } from "./keymap.ts";
import { KeysDialog } from "./keys-dialog.tsx";

/** Per-request data every page needs for its chrome (bar, health pill and popover). */
export interface Chrome {
  health: Health;
  now: number;
  host: string;
  /** Links the public reader serves now (COUNT over liveLinkWhere). */
  liveLinkCount: number;
  /** Unrevoked, unexpired links on collections in Trash (COUNT over pausedLinkWhere). */
  pausedLinkCount: number;
  /** Collections in Trash: tombstoned, pending-trashed or being purged, each once. */
  trashCount: number;
  /** Collections trashed while still pending (trashedPendingIds), cached for the request. */
  trashedPending: readonly string[];
}

export function Layout(props: {
  title: string;
  chrome: Chrome;
  bar: Child;
  children: Child;
  page: string;
  /** The collection's title on collection, Changes and gallery pages: Find's Files row. */
  findIn?: string | undefined;
}) {
  const pageScript = props.page === "changes" || props.page === "gallery";
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <title>{props.title === "Waypoint" ? "Waypoint" : `${props.title} · Waypoint`}</title>
        <link rel="icon" href={faviconAsset.url} type="image/svg+xml" />
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
        <KeysDialog page={props.page} />
        <FindDialog findIn={props.findIn} />
        <ConfirmDialog />
        <div class="pop-scrim" aria-hidden="true" />
        <div class="toasts" data-toast popover="manual">
          <div
            class="toast success"
            data-toast-slot="success"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          />
          <div class="toast error" data-toast-slot="error" role="alert" aria-atomic="true" />
        </div>
        <script src={clientAsset.url} defer />
        {pageScript ? <script src={pagesAsset.url} defer /> : null}
      </body>
    </html>
  );
}

export type HomeBarCurrent = "recent" | "links" | "trash" | "status" | "mcp" | null;

/** The phone switcher's label: where you are ("Go to" on a page that isn't a destination). */
const WHERE: Readonly<Record<NonNullable<HomeBarCurrent>, string>> = {
  recent: "Recent",
  links: "Public links",
  trash: "Trash",
  status: "Status",
  mcp: "Connect an agent",
};

/** "Public links 4": the live count follows the label, and nothing at 0. */
function LinksLabel(props: { live: number }) {
  return (
    <>
      Public links
      {props.live > 0 ? (
        <>
          {" "}
          <span class="n">{props.live}</span>
        </>
      ) : null}
    </>
  );
}

/**
 * "Trash 2, 1 public link paused": the count, then the paused links for screen readers only.
 * Browsers put a space before an out-of-flow (.sr) or blockified (.n in a flex or grid item)
 * child when they compute a name, which would read "Trash 2 , 1 …"; so while links are paused
 * the hidden text repeats the count and the visible count is hidden from the name instead.
 * With no count to repeat, it repeats the label ("Trash, 1 public link paused").
 */
function TrashLabel(props: { trash: number; paused: number }) {
  const { trash, paused } = props;
  const suffix = paused > 0 ? `, ${plural(paused, "public link")} paused` : "";
  return (
    <>
      {trash === 0 && suffix ? <span aria-hidden="true">Trash</span> : "Trash"}
      {trash > 0 ? (
        <>
          {" "}
          <span class="n" aria-hidden={suffix ? "true" : undefined}>
            {trash}
          </span>
        </>
      ) : null}
      {suffix ? (
        <span class="sr">
          {trash > 0 ? trash : "Trash"}
          {suffix}
        </span>
      ) : null}
    </>
  );
}

/**
 * The bar every page outside a collection shares (NAV-01): Recent, Public links and Trash tabs
 * with their live counts (Chrome's, per request), the inline search, the health pill and ⋯. On
 * phones the tabs fold into a "Go to" sheet opened from the current page's name.
 */
export function HomeBar(props: {
  chrome: Chrome;
  current: HomeBarCurrent;
  q?: string | undefined;
}) {
  const { chrome, current } = props;
  const here = (page: NonNullable<HomeBarCurrent>) => (current === page ? "page" : undefined);
  const where = current ? WHERE[current] : "Go to";
  const live = chrome.liveLinkCount;
  const trash = <TrashLabel trash={chrome.trashCount} paused={chrome.pausedLinkCount} />;
  return (
    <header class="bar">
      <a class="logo" href="/" aria-label="Waypoint, Recent">
        <LogoMark />
        <span class="hide-sm">Waypoint</span>
      </a>
      <nav class="gnav hide-sm" aria-label="Main">
        <a href="/" aria-current={here("recent")}>
          Recent
        </a>
        <a
          href="/links"
          aria-current={here("links")}
          title={live > 0 ? plural(live, "live public link") : undefined}
        >
          <LinksLabel live={live} />
        </a>
        <a href="/trash" aria-current={here("trash")}>
          {trash}
        </a>
      </nav>
      {/* The hidden text repeats the label, for the same reason as TrashLabel's: the button is a
          grid, so a name built from "Recent" and a separate ", go to …" would read "Recent , go". */}
      <button type="button" class="where show-sm" popovertarget="go-to">
        <span aria-hidden="true">{where}</span>
        {raw(icon("chevronDown", "sm"))}
        <span class="sr">{where}, go to another page</span>
      </button>
      <form class="search hide-sm" role="search" action="/" method="get" data-search>
        {raw(icon("search"))}
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
        <div class="suggest" id="suggest" role="listbox" aria-label="Suggestions" hidden />
        <span class="sr" role="status" data-search-status />
      </form>
      <span class="grow" />
      <FindButton class="show-sm" />
      <HealthPill health={chrome.health} />
      <button
        type="button"
        class="iconbtn hide-sm"
        popovertarget="home-more"
        aria-haspopup="menu"
        aria-label="More"
        title="More"
      >
        {raw(icon("more", "lg"))}
      </button>
      <div id="home-more" class="menu" popover="auto" role="menu" aria-label="More">
        <div class="mbox">
          <a class="mi" role="menuitem" href="/status" aria-current={here("status")}>
            <span>Status</span>
            <span>
              {keycaps(keyFor("go-status")).map((cap, index) => (
                <>
                  {index ? " " : ""}
                  <kbd>{cap}</kbd>
                </>
              ))}
            </span>
          </a>
          <a class="mi" role="menuitem" href="/mcp" aria-current={here("mcp")}>
            <span>Connect an agent</span>
          </a>
          <button type="button" class="mi" role="menuitem" commandfor="keys" command="show-modal">
            <span>Keyboard shortcuts</span>
            <kbd>{keyFor("keys")}</kbd>
          </button>
        </div>
      </div>
      <div id="go-to" class="menu navsheet" popover="auto">
        <nav class="mbox" aria-label="Go to">
          <div class="lbl" aria-hidden="true">
            Go to
          </div>
          <a class="mi" href="/" aria-current={here("recent")}>
            Recent
          </a>
          <a class="mi" href="/links" aria-current={here("links")}>
            <LinksLabel live={live} />
          </a>
          <a class="mi" href="/trash" aria-current={here("trash")}>
            {trash}
          </a>
          <hr />
          <a class="mi" href="/status" aria-current={here("status")}>
            Status
          </a>
          <a class="mi" href="/mcp" aria-current={here("mcp")}>
            Connect an agent
          </a>
        </nav>
      </div>
    </header>
  );
}

/** Opens Find (`/` does too, on pages without a visible search field). */
export function FindButton(props: { class?: string }) {
  return (
    <button
      type="button"
      class={props.class ? `iconbtn ${props.class}` : "iconbtn"}
      commandfor="find"
      command="show-modal"
      aria-label="Find"
      aria-keyshortcuts={ariaKeyshortcuts("find")}
      title={keyTitle("find")}
    >
      {raw(icon("search", "lg"))}
    </button>
  );
}

const FIND_TOKENS = ["is:public", "is:failed", "in:trash", "project:"] as const;

/**
 * Find (NAV-02): one dialog on every page, for finding collections. The form is a [data-search]
 * combobox like the bar's field (client/search.ts fills its listbox) and fills the dialog
 * (padding 0), so a click whose target is the dialog itself landed on ::backdrop. On collection
 * pages, a dead-end row points file searches at the Files tab.
 */
export function FindDialog(props: { findIn?: string | undefined }) {
  return (
    <dialog id="find" class="find" aria-labelledby="find-title" closedby="any">
      <h2 id="find-title" class="sr">
        Find a collection
      </h2>
      <form class="find-form" role="search" action="/" method="get" data-search data-find>
        <div class="find-q">
          {raw(icon("search"))}
          <input
            type="search"
            name="q"
            placeholder="Find a collection, or paste a URL or ID"
            aria-label="Find a collection, or paste a URL or ID"
            autocomplete="off"
            autocapitalize="none"
            enterkeyhint="search"
            spellcheck={false}
            autofocus
            role="combobox"
            aria-expanded="false"
            aria-controls="find-suggest"
            aria-autocomplete="list"
          />
          <button type="button" class="find-cancel" commandfor="find" command="close">
            Cancel
          </button>
        </div>
        <div class="find-body">
          <div class="suggest" id="find-suggest" role="listbox" aria-label="Suggestions" hidden />
          <div class="find-tokens" role="group" aria-label="Filters">
            <span class="find-tl" aria-hidden="true">
              Filters
            </span>
            {FIND_TOKENS.map((token) => (
              <button type="button" data-token={token} aria-pressed="false">
                {token}
              </button>
            ))}
          </div>
          {props.findIn ? (
            <p class="find-files">
              Looking for a file in <b>{props.findIn}</b>?{" "}
              <a href="?panel=files" data-find-files>
                Open Files<span aria-hidden="true"> ›</span>
              </a>
            </p>
          ) : null}
        </div>
        <p class="find-hints">
          <kbd>↑↓</kbd> move · <kbd>↵</kbd> open · <kbd>⇧↵</kbd> all results · Paste a Waypoint URL
          or ID to jump to it
        </p>
        <span class="sr" role="status" data-search-status />
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
      <h1>Not found</h1>
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
