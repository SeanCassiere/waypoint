/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import type { HttpServices } from "../../http.ts";
import {
  isLive,
  isOpen,
  linkPage,
  LINKS_PAGE,
  sharingEnabled,
  URL_UNAVAILABLE,
  type LinkFilter,
  type ShareView,
} from "../../shares.ts";
import { shellPath } from "../../viewer-paths.ts";
import { getChrome } from "../chrome.ts";
import { Globe, Spinner, Time } from "../components.tsx";
import { plural } from "../format.ts";
import { HomeBar, Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";
import type { CollectionContext } from "./collection/index.tsx";

const DAY = 86_400_000;

export function StateChip(props: { link: ShareView }) {
  const { state, status } = props.link;
  // Status first: a paused or waiting link isn't served, whatever its push lifecycle (OW-05).
  if (status === "paused")
    return (
      <span class="chip" data-link-state="paused">
        Paused
      </span>
    );
  if (status === "waiting")
    return (
      <span class="chip pending" data-link-state="waiting">
        Waiting
      </span>
    );
  if (state === "active")
    return (
      <span class="chip public" data-link-state="active">
        <Globe />
        Active
      </span>
    );
  if (state === "activating")
    return (
      <span class="chip pending" data-link-state="activating">
        <Spinner />
        Activating
      </span>
    );
  // A revocation is final the moment the writer records it; the reader catches up within
  // seconds, which the card notes ("revoking" in the API).
  return (
    <span class="chip" data-link-state={state}>
      {state === "expired" ? "Expired" : "Revoked"}
    </span>
  );
}

/** "Only #3", "Latest · now #3", or "Latest · public sees #3 until #4 syncs". */
export function showsText(link: ShareView, newest: number | null): string {
  if (link.revision_id) return `Only #${link.revision_display_number ?? "?"}`;
  if (link.status !== "active" && link.status !== "waiting") return "Latest";
  const sees = link.public_sees?.display_number ?? null;
  if (sees === null) return "Latest · nothing synced yet";
  if (newest !== null && newest !== sees)
    return `Latest · public sees #${sees} until #${newest} syncs`;
  return `Latest · now #${sees}`;
}

/** Links can be listed and revoked without the token key, but not created or copied. */
export const KEY_MISSING =
  "WAYPOINT_SHARE_TOKEN_KEY isn't set on this writer, so new links can't be created and link URLs can't be shown. Existing links can still be revoked.";
/** Shown once the revocation has been pushed, while the reader's 5 s cache runs out. */
export const STOPS_SOON = "Public access stops within seconds.";
/** Shown while the revocation hasn't reached the cloud: the reader still serves the link. */
export const NOT_PUSHED = "Revoked, not yet pushed. Public access continues until it syncs.";

/** The note under a revoked link while the public reader may still serve it. */
export function RevokeNote(props: { link: ShareView; inline?: boolean }) {
  const { link } = props;
  if (link.state !== "revoking") return null;
  const text = link.revocation_pushed ? STOPS_SOON : NOT_PUSHED;
  const pushed = link.revocation_pushed ? "true" : "false";
  return props.inline ? (
    <span class="stops" data-stops={pushed}>
      {text}
    </span>
  ) : (
    <p class="note stops" data-stops={pushed}>
      {text}
    </p>
  );
}

/** Copy URL (the card's primary action) and Open, or why the URL can't be shown. */
export function LinkUrlActions(props: { link: ShareView; sharing?: boolean }) {
  const { url } = props.link;
  // Without sharing configured, no URL can be derived for any link.
  if (props.sharing === false) return null;
  if (!url)
    return (
      <details class="why" data-url-missing>
        <summary class="chip xs">URL unavailable</summary>
        <p class="note">{URL_UNAVAILABLE}</p>
      </details>
    );
  return (
    <>
      <button
        type="button"
        class="btn sm"
        data-action="copy-text"
        data-text={url}
        data-label="public link"
        data-copy-url
        title={url}
      >
        <span aria-hidden="true">⧉</span>
        Copy URL
      </button>
      <a class="btn sm ghost" href={url} target="_blank" rel="noopener noreferrer" data-open-url>
        Open ↗
      </a>
    </>
  );
}

function LinkCard(props: {
  link: ShareView;
  now: number;
  newest: number | null;
  sharing: boolean;
}) {
  const { link, now } = props;
  // Live, waiting and paused cards keep their actions (and a paused one its Trash note).
  const live = isOpen(link);
  const soon = live && link.expires_at !== null && link.expires_at - now < DAY;
  return (
    <div class={`lnk${live ? "" : " dead"}`} data-link={link.id} data-link-status={link.status}>
      <div class="h">
        <b>{link.label || "(no label)"}</b>
        <StateChip link={link} />
      </div>
      <dl>
        <dt>Shows</dt>
        <dd>{showsText(link, props.newest)}</dd>
        <dt>Created</dt>
        <dd>
          <Time at={link.created_at} fmt="day" now={now} />
        </dd>
        {link.revoked_at !== null ? (
          <>
            <dt>Revoked</dt>
            <dd>
              <Time at={link.revoked_at} fmt="ago" now={now} />
            </dd>
          </>
        ) : link.state === "expired" && link.expires_at !== null ? (
          <>
            <dt>Expired</dt>
            <dd>
              <Time at={link.expires_at} fmt="date" now={now} />
            </dd>
          </>
        ) : (
          <>
            <dt>Expires</dt>
            <dd class={soon ? "soon" : undefined}>
              {link.expires_at === null ? (
                "Never"
              ) : (
                <Time at={link.expires_at} fmt="until" now={now} />
              )}
            </dd>
          </>
        )}
        {link.collection.deleted && live ? (
          <>
            <dt>Now</dt>
            <dd>Inactive while the collection is in Trash</dd>
          </>
        ) : null}
      </dl>
      <RevokeNote link={link} />
      {live ? (
        <div class="row">
          <LinkUrlActions link={link} sharing={props.sharing} />
          <span class="grow" />
          {soon ? (
            <details class="act">
              <summary class="txtbtn">Extend…</summary>
              <div class="pop neutral" role="group" aria-label="Extend this link">
                <span>
                  Keep this link working longer. The new expiry reaches viewers within seconds.
                </span>
                <span class="row">
                  <button type="button" class="btn sm" data-action="close-details">
                    Keep as is
                  </button>
                  <button
                    type="button"
                    class="btn sm"
                    data-action="extend-link"
                    data-id={link.id}
                    data-days="7"
                    data-from={String(link.expires_at)}
                  >
                    +7 days
                  </button>
                  <button
                    type="button"
                    class="btn sm"
                    data-action="extend-link"
                    data-id={link.id}
                    data-days="30"
                    data-from={String(link.expires_at)}
                  >
                    +30 days
                  </button>
                </span>
              </div>
            </details>
          ) : null}
          <details class="act">
            <summary class="txtbtn danger">Revoke…</summary>
            <div class="pop" role="group" aria-label="Confirm revoke">
              <span>
                <b>Revoke this link?</b> People using it lose access within seconds. You can't undo
                this.
              </span>
              <span class="row">
                <button type="button" class="btn sm" data-action="close-details">
                  Keep
                </button>
                <button
                  type="button"
                  class="btn sm danger"
                  data-action="revoke-link"
                  data-id={link.id}
                >
                  Revoke link
                </button>
              </span>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The collection panel's Links tab (spec §4.17, reworked from owner feedback): one primary
 * action, a quiet secondary row, calm cards with Copy URL first, and "Revoke all" demoted to
 * a text action under the cards when there's more than one link to revoke.
 */
export function LinksPanel(props: {
  ctx: CollectionContext;
  links: ShareView[];
  previewHref: string;
}) {
  const { ctx, links } = props;
  // Cards for every open link (live, waiting, paused); Revoke all counts them all.
  const live = links.filter(isOpen);
  const dead = links.filter((link) => !isOpen(link));
  const newest = ctx.latest?.display_number ?? null;
  return (
    <>
      <div class="lnk-acts">
        {ctx.sharing ? (
          <button type="button" class="btn public center" commandfor="share" command="show-modal">
            <Globe />
            New public link
          </button>
        ) : (
          <p class="note">{KEY_MISSING}</p>
        )}
        <a class="txtbtn" href={props.previewHref} target="_blank" rel="noopener">
          Preview as public ↗
        </a>
      </div>
      {live.map((link) => (
        <LinkCard link={link} now={ctx.chrome.now} newest={newest} sharing={ctx.sharing} />
      ))}
      {!live.length ? <p class="legend">No active links. Create one with Share.</p> : null}
      {live.length >= 2 ? (
        <div class="lnk-foot">
          <button
            type="button"
            class="txtbtn danger"
            data-action="revoke-all"
            data-collection-id={ctx.collection.id}
            data-count={String(live.length)}
            data-noun="links"
          >
            Revoke all {live.length} links…
          </button>
        </div>
      ) : null}
      {dead.length ? (
        <details class="inactive">
          <summary>Show {dead.length} inactive</summary>
          {dead.map((link) => (
            <LinkCard link={link} now={ctx.chrome.now} newest={newest} sharing={ctx.sharing} />
          ))}
        </details>
      ) : null}
    </>
  );
}

/** The status line's public segment, when a live link follows latest. */
export function publicSegment(
  links: ShareView[],
): { tone: "public"; body: Child; text: string; brief: string } | null {
  const live = links.filter(isLive);
  const following = live.find((link) => !link.revision_id);
  if (!following) return null;
  const who = following.label ? `“${following.label}”` : "A link";
  return {
    tone: "public",
    text: `Public: ${plural(live.length, "active link")}. ${who} follows latest, so new revisions become public within seconds of syncing.`,
    brief: `Public: ${who} follows latest`,
    body: (
      <span>
        <span class="pubseg">
          <Globe /> Public
        </span>{" "}
        {plural(live.length, "active link")}. <b>{who} follows latest</b>
        <span class="long">, so new revisions become public within seconds of syncing.</span>
      </span>
    ),
  };
}

/** Create a public link (4.15) and Link created (4.16): one dialog, two steps. */
export function ShareDialog(props: {
  ctx: CollectionContext;
  links: ShareView[];
  previewHref: string;
}) {
  const { ctx } = props;
  const { revision, latest, rows } = ctx;
  const n = revision.display_number ?? 0;
  const latestN = latest?.display_number ?? n;
  const synced = rows.filter((row) => row.sync_state === "synced");
  const newestSynced = synced.at(-1);
  const hosts = [
    ...new Set(ctx.timeline.map((row) => row.host).filter((host): host is string => Boolean(host))),
  ];
  const files = ctx.files.map((file) => file.path);
  const shown =
    files.slice(0, 6).join(" · ") + (files.length > 6 ? ` · +${files.length - 6} more` : "");
  const liveCount = props.links.filter(isLive).length;
  const onlyUnsynced = revision.sync_state !== "synced";
  const latestUnsynced = Boolean(latest && latest.sync_state !== "synced" && newestSynced);
  const nothingSynced = !newestSynced;
  const failed = revision.sync_state === "failed";
  return (
    <dialog
      class="dlg share"
      id="share"
      aria-labelledby="share-title"
      aria-describedby="share-desc"
      data-share-dialog
      data-n={String(n)}
      data-latest-n={String(latestN)}
    >
      <div data-share-step="create">
        <div class="band">
          <Globe />
          <div>
            <h2 id="share-title">Create a public link</h2>
            <p id="share-desc">
              Anyone who has the link can read this on the open internet. No Tailscale, no login.
            </p>
          </div>
        </div>
        <form data-share-form>
          <div class="bd">
            <fieldset>
              <legend>The link shows</legend>
              <div class="opts">
                <label class="opt">
                  <input
                    type="radio"
                    name="target"
                    value="only"
                    checked={!failed}
                    disabled={failed}
                  />
                  <b>Only #{n}</b>
                  <span>
                    {failed
                      ? `#${n} failed to sync, so it can't be shared.`
                      : "A fixed snapshot. Later revisions stay private."}
                  </span>
                </label>
                <label class="opt">
                  <input type="radio" name="target" value="latest" checked={failed} />
                  <b>Latest revision</b>
                  <span>
                    Always the newest synced revision, including <strong>future ones</strong>.
                  </span>
                </label>
              </div>
            </fieldset>
            {nothingSynced ? (
              <div class="warn" role="note" data-warn>
                <span aria-hidden="true">!</span>
                <span>
                  <b>Nothing in this collection has synced yet.</b>The link won't work until it
                  does.
                </span>
              </div>
            ) : (
              <>
                {onlyUnsynced && !failed ? (
                  <div class="warn when-only" role="note" data-warn>
                    <span aria-hidden="true">!</span>
                    <span>
                      <b>#{n} hasn't synced yet.</b>An “Only #{n}” link shows “not available” until
                      it syncs.
                    </span>
                  </div>
                ) : null}
                {latestUnsynced ? (
                  <div class="warn when-latest" role="note" data-warn>
                    <span aria-hidden="true">!</span>
                    <span>
                      <b>#{latestN} hasn't synced yet.</b>A Latest link shows #
                      {newestSynced?.display_number} until then.
                    </span>
                  </div>
                ) : null}
              </>
            )}
            <div class="fields">
              <label class="fl">
                Label <small>Who it's for (only you see this)</small>
                <input
                  name="label"
                  maxLength={80}
                  placeholder="e.g. Priya, payments review"
                  autocomplete="off"
                />
              </label>
              <div class="fl">
                <span id="share-expiry">Expires</span>
                <small>You can revoke it sooner</small>
                <div class="expiry" role="radiogroup" aria-labelledby="share-expiry">
                  {[
                    ["1", "1 day"],
                    ["7", "7 days"],
                    ["30", "30 days"],
                    ["never", "Never"],
                  ].map(([value, label]) => (
                    <label>
                      {label}
                      <input type="radio" name="expires" value={value} checked={value === "7"} />
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <details class="sees" open data-sees>
              <summary>
                <h3>What the public will see</h3>
                <span class="sum-sm">
                  Title + all {files.length} files in #<span class="when-only">{n}</span>
                  <span class="when-latest">{latestN}</span>
                  <span class="when-latest"> + future revisions</span>
                </span>
              </summary>
              <div class="row">
                <span class="yes" aria-hidden="true">
                  ✓
                </span>
                <span>
                  The title <b>“{ctx.collection.title}”</b>
                </span>
              </div>
              <div class="row">
                <span class="yes" aria-hidden="true">
                  ✓
                </span>
                <span>
                  <b>{files.length === 1 ? "The file" : `All ${files.length} files`}</b> in #
                  <span class="when-only">{n}</span>
                  <span class="when-latest">{newestSynced?.display_number ?? latestN}</span>
                  {files.length === 1 ? "" : ", not just the one you're reading"}
                  <br />
                  <span class="files">{shown}</span>
                </span>
              </div>
              <div class="row when-latest">
                <span class="bang" aria-hidden="true">
                  !
                </span>
                <span>
                  <b>Every future revision</b>, by any agent on{" "}
                  <span class="mono">{hosts.length ? hosts.join(", ") : "any machine"}</span>,
                  within seconds of syncing, with no review step
                </span>
              </div>
              <div class="row when-never">
                <span class="bang" aria-hidden="true">
                  !
                </span>
                <span>
                  <b>No expiry.</b> It stays public until you revoke it.
                </span>
              </div>
              <div class="row">
                <span class="no" aria-hidden="true">
                  ✕
                </span>
                <span class="muted">
                  Other revisions, revision messages, metadata, machine names, and your other
                  collections
                </span>
              </div>
            </details>
          </div>
          <div class="ft sticky">
            <span class="grow">
              <a href={props.previewHref} target="_blank" rel="noopener">
                Preview as public ↗
              </a>
              {liveCount ? (
                <span class="exist">
                  {" · Already has "}
                  <a href="?panel=links">{plural(liveCount, "link")}</a>
                </span>
              ) : null}
            </span>
            <button class="btn" formmethod="dialog" formnovalidate value="cancel">
              Cancel
            </button>
            <button class="btn public-solid" data-share-submit>
              Create link
            </button>
          </div>
          <p class="alert" role="alert" data-share-error />
        </form>
      </div>
      <div data-share-step="created" hidden>
        <div class="band">
          <Globe />
          <div>
            <h2 id="share-created-title">Link created</h2>
            <p>
              Anyone who has it can read this. You can copy it again any time from the Links tab.
            </p>
          </div>
        </div>
        <div class="bd">
          <div class="tok">
            <code data-share-url />
            <button type="button" data-share-copy>
              Copy
            </button>
          </div>
          <div class="once">
            <span class="state pending" data-share-state>
              <Spinner />
              Activating
            </span>
            <span role="status" data-share-state-text>
              Works for viewers within seconds, once the writer pushes it to the cloud. This updates
              by itself.
            </span>
          </div>
          <dl class="kv flat">
            <dt>Label</dt>
            <dd data-share-label />
            <dt>Shows</dt>
            <dd data-share-shows />
            <dt>Expires</dt>
            <dd data-share-expires />
          </dl>
        </div>
        <div class="ft">
          <span class="grow">
            <a href="#" target="_blank" rel="noopener noreferrer" data-share-open>
              Open ↗
            </a>
          </span>
          <button type="button" class="btn primary" data-share-done>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** /links: every public link across collections (spec §5.7, shares.html). */
export async function linksPage(s: HttpServices, c: Context): Promise<Response> {
  const now = Date.now();
  const raw = c.req.query("state");
  const filter: LinkFilter =
    raw === "paused" ||
    raw === "waiting" ||
    raw === "expired" ||
    raw === "revoked" ||
    raw === "inactive"
      ? raw
      : "active";
  // One page at a time, counted in SQL: prod-sized link lists made this page megabytes.
  const chrome = await getChrome(s, now);
  const {
    views: shown,
    counts,
    remaining,
    next,
  } = await linkPage(s, filter, c.req.query("after"), now, chrome.trashedPending);
  const inactive = counts.expired + counts.revoked;
  const sharing = sharingEnabled(s);
  return noStore(
    c.html(
      <Layout
        title="Public links"
        chrome={chrome}
        bar={<HomeBar chrome={chrome} current="links" />}
        page="links"
      >
        <main class="wrap" id="main">
          <div class="ph">
            <div>
              <h1>
                <Globe /> Public links
              </h1>
              <p>
                Everything readable outside your tailnet right now. Revoking takes effect within
                seconds.
              </p>
              {sharing ? null : <p class="note">{KEY_MISSING}</p>}
            </div>
          </div>
          <div class="filters">
            <nav class="seg" aria-label="Filter links">
              {(
                [
                  ["active", "Active"],
                  ["paused", "Paused in Trash"],
                  ["expired", "Expired"],
                  ["revoked", "Revoked"],
                ] as const
              ).map(([key, label]) => (
                <a href={`/links?state=${key}`} aria-current={key === filter ? "page" : undefined}>
                  {label} <span data-count-of={key}>{counts[key]}</span>
                </a>
              ))}
            </nav>
          </div>
          <div class="rows">
            {shown.length ? (
              shown.map((link) => (
                <div
                  class={`r${isOpen(link) ? "" : " dead"}`}
                  data-link={link.id}
                  data-link-status={link.status}
                >
                  <span class="t">
                    {link.collection.public_id && !link.collection.deleted ? (
                      <a href={`/c/${link.collection.public_id}/?panel=links`}>
                        {link.collection.title}
                      </a>
                    ) : (
                      <span>{link.collection.title || "Unknown collection"}</span>
                    )}{" "}
                    · {link.label || "(no label)"}
                  </span>
                  {isOpen(link) ? (
                    <div class="acts">
                      <LinkUrlActions link={link} sharing={sharing} />
                      <button
                        type="button"
                        class="txtbtn danger"
                        data-action="revoke-link"
                        data-id={link.id}
                        data-confirm="true"
                      >
                        Revoke…
                      </button>
                    </div>
                  ) : null}
                  <span class="s">
                    <StateChip link={link} />
                    <span class={`chip xs${link.revision_id ? "" : " public"}`}>
                      {link.revision_id ? null : <Globe />}
                      {showsText(link, null)}
                    </span>
                    <RevokeNote link={link} inline />
                    {link.collection.deleted ? <span>inactive while in Trash</span> : null}
                    {isOpen(link) ? (
                      link.expires_at === null ? (
                        <span class="soon" data-live>
                          never expires
                        </span>
                      ) : (
                        <span class={link.expires_at - now < DAY ? "soon" : undefined} data-live>
                          expires <Time at={link.expires_at} fmt="until" now={now} />
                        </span>
                      )
                    ) : link.revoked_at !== null ? (
                      <span>
                        revoked <Time at={link.revoked_at} fmt="ago" now={now} />
                      </span>
                    ) : link.expires_at !== null ? (
                      <span>
                        expired <Time at={link.expires_at} fmt="date" now={now} />
                      </span>
                    ) : null}
                    <span>
                      created <Time at={link.created_at} fmt="day" now={now} />
                    </span>
                  </span>
                </div>
              ))
            ) : (
              <div class="empty">
                {filter === "active"
                  ? "No public links. Nothing is readable outside your tailnet."
                  : `No ${filter} links.`}
              </div>
            )}
          </div>
          {filter === "active" && counts.active >= 2 ? (
            <div class="lnk-foot">
              <button
                type="button"
                class="txtbtn danger"
                data-action="revoke-all"
                data-count={String(counts.active)}
                data-noun="active links"
              >
                Revoke all {counts.active} active links…
              </button>
            </div>
          ) : null}
          {next ? (
            <p class="legend" data-more>
              <a href={`/links?${new URLSearchParams({ state: filter, after: next }).toString()}`}>
                Show {Math.min(remaining, LINKS_PAGE)} more of {remaining}…
              </a>
            </p>
          ) : null}
          {filter === "active" && inactive ? (
            <p class="legend" data-inactive>
              <a href="/links?state=inactive">Show {plural(inactive, "inactive link")}</a> (expired
              or revoked)
            </p>
          ) : null}
        </main>
      </Layout>,
    ),
  );
}

export function previewHref(ctx: CollectionContext, path: string): string {
  return `${shellPath(ctx.collection.public_id, ctx.revision.public_id, path, ctx.pinned, ctx.revision.head_path)}?as=public`;
}
