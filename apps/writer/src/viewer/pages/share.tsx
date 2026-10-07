/** @jsxImportSource hono/jsx */
import type { Context } from "hono";
import type { Child } from "hono/jsx";

import type { HttpServices } from "../../http.js";
import { allLinks, inFilter, type LinkFilter, type ShareView } from "../../shares.js";
import { shellPath } from "../../viewer-paths.js";
import { getChrome } from "../chrome.js";
import { Globe, Spinner, Time } from "../components.js";
import { plural } from "../format.js";
import { HomeBar, Layout } from "../layout.js";
import { noStore } from "../respond.js";
import type { CollectionContext } from "./collection.js";

const DAY = 86_400_000;
export const isLive = (link: ShareView) => link.state === "active" || link.state === "activating";

export function StateChip(props: { link: ShareView }) {
  const { state } = props.link;
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
  if (state === "revoking")
    return (
      <span class="chip" data-link-state="revoking">
        <Spinner />
        Revoking
      </span>
    );
  return (
    <span class="chip" data-link-state={state}>
      {state === "expired" ? "Expired" : "Revoked"}
    </span>
  );
}

/** "Only #3", "Latest · now #3", or "Latest · public sees #3 until #4 syncs". */
export function showsText(link: ShareView, newest: number | null): string {
  if (link.revision_id) return `Only #${link.revision_display_number ?? "?"}`;
  if (!isLive(link)) return "Latest";
  const sees = link.public_sees?.display_number ?? null;
  if (sees === null) return "Latest · nothing synced yet";
  if (newest !== null && newest !== sees)
    return `Latest · public sees #${sees} until #${newest} syncs`;
  return `Latest · now #${sees}`;
}

function LinkCard(props: { link: ShareView; now: number; newest: number | null }) {
  const { link, now } = props;
  const soon = isLive(link) && link.expires_at !== null && link.expires_at - now < DAY;
  return (
    <div class={`lnk${isLive(link) ? "" : " dead"}`} data-link={link.id}>
      <div class="h">
        <b>{link.label ?? "(no label)"}</b>
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
              {link.state === "revoking" ? " · stops working within 60 s" : ""}
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
        {link.collection.deleted && isLive(link) ? (
          <>
            <dt>Now</dt>
            <dd>Inactive while the collection is in Trash</dd>
          </>
        ) : null}
      </dl>
      {isLive(link) ? (
        <div class="row">
          {soon ? (
            <details class="act">
              <summary class="btn sm">Extend…</summary>
              <div class="pop neutral">
                <span>
                  Keep this link working longer. The new expiry reaches viewers within a minute.
                </span>
                <span class="row">
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
            <summary class="btn sm danger">Revoke…</summary>
            <div class="pop" role="group" aria-label="Confirm revoke">
              <span>
                <b>Revoke this link?</b> People using it lose access within about a minute. You
                can't undo this.
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

/** The collection panel's Links tab (spec §4.17). */
export function LinksPanel(props: {
  ctx: CollectionContext;
  links: ShareView[];
  previewHref: string;
}) {
  const { ctx, links } = props;
  const live = links.filter(isLive);
  const dead = links.filter((link) => !isLive(link));
  const newest = ctx.latest?.display_number ?? null;
  return (
    <>
      <div class="lnk-acts">
        <button
          type="button"
          class="btn public wide center"
          commandfor="share"
          command="show-modal"
        >
          <Globe />
          New public link
        </button>
        <a class="btn ghost sm center" href={props.previewHref} target="_blank" rel="noopener">
          Preview as public ↗
        </a>
        {live.length ? (
          <button
            type="button"
            class="btn sm danger center"
            data-action="revoke-all"
            data-collection-id={ctx.collection.id}
            data-count={String(live.length)}
          >
            Revoke all {live.length}…
          </button>
        ) : null}
      </div>
      {live.map((link) => (
        <LinkCard link={link} now={ctx.chrome.now} newest={newest} />
      ))}
      {!live.length ? <p class="legend">No active links. Create one with Share.</p> : null}
      {dead.length ? (
        <details class="inactive">
          <summary>Show {dead.length} inactive</summary>
          {dead.map((link) => (
            <LinkCard link={link} now={ctx.chrome.now} newest={newest} />
          ))}
        </details>
      ) : null}
    </>
  );
}

/** The status line's public segment, when a live link follows latest. */
export function publicSegment(links: ShareView[]): { tone: "public"; body: Child } | null {
  const live = links.filter(isLive);
  const following = live.find((link) => !link.revision_id);
  if (!following) return null;
  return {
    tone: "public",
    body: (
      <span>
        <span class="pubseg">
          <Globe /> Public
        </span>{" "}
        {plural(live.length, "active link")}.{" "}
        <b>{following.label ? `“${following.label}”` : "A link"} follows latest</b>
        <span class="long">, so new revisions become public about a minute after they sync.</span>
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
                  <span class="mono">{hosts.length ? hosts.join(", ") : "any machine"}</span>, about
                  a minute after it syncs, with no review step
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
            <h2 id="share-created-title">Copy your link now</h2>
            <p>
              Waypoint keeps only a fingerprint of it, so this is the only time you'll see the full
              link.
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
              Works for viewers in about a minute, after the writer pushes it to the cloud. This
              updates by itself.
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
          <div class="pop neutral" role="alert" data-share-uncopied hidden>
            <span>You haven't copied the link. Close anyway? It can't be shown again.</span>
            <span class="row">
              <button type="button" class="btn sm" data-share-back>
                Go back
              </button>
              <button type="button" class="btn sm danger" data-share-force>
                Close
              </button>
            </span>
          </div>
        </div>
        <div class="ft">
          <span class="grow" />
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
  const filter: LinkFilter = raw === "expired" || raw === "revoked" ? raw : "active";
  const [views, chrome] = await Promise.all([allLinks(s), getChrome(s, now)]);
  const counts = {
    active: views.filter((view) => inFilter(view, "active")).length,
    expired: views.filter((view) => inFilter(view, "expired")).length,
    revoked: views.filter((view) => inFilter(view, "revoked")).length,
  };
  const shown = views.filter((view) => inFilter(view, filter));
  return noStore(
    c.html(
      <Layout title="Public links" chrome={chrome} bar={<HomeBar chrome={chrome} />} page="links">
        <main class="wrap" id="main">
          <div class="ph">
            <div>
              <h2>
                <Globe /> Public links
              </h2>
              <p>
                Everything readable outside your tailnet right now. Revoking takes effect within
                about a minute.
              </p>
            </div>
          </div>
          <div class="filters">
            <nav class="seg" aria-label="Filter links">
              {(["active", "expired", "revoked"] as const).map((key) => (
                <a href={`/links?state=${key}`} aria-current={key === filter ? "page" : undefined}>
                  {key[0]?.toUpperCase()}
                  {key.slice(1)} {counts[key]}
                </a>
              ))}
            </nav>
            <span class="grow" />
            {filter === "active" && counts.active ? (
              <button
                type="button"
                class="btn sm danger"
                data-action="revoke-all"
                data-count={String(counts.active)}
              >
                Revoke all {counts.active} active…
              </button>
            ) : null}
          </div>
          <div class="rows">
            {shown.length ? (
              shown.map((link) => (
                <div class={`r${isLive(link) ? "" : " dead"}`}>
                  <span class="t">
                    {link.collection.public_id && !link.collection.deleted ? (
                      <a href={`/c/${link.collection.public_id}/?panel=links`}>
                        {link.collection.title}
                      </a>
                    ) : (
                      <span>{link.collection.title || "Unknown collection"}</span>
                    )}{" "}
                    · {link.label ?? "(no label)"}
                  </span>
                  {isLive(link) ? (
                    <span class="acts">
                      <button
                        type="button"
                        class="btn sm danger"
                        data-action="revoke-link"
                        data-id={link.id}
                        data-confirm="true"
                      >
                        Revoke…
                      </button>
                    </span>
                  ) : null}
                  <span class="s">
                    <span class={`chip xs${link.revision_id ? "" : " public"}`}>
                      {link.revision_id ? null : <Globe />}
                      {showsText(link, null)}
                    </span>
                    {link.state === "activating" ? (
                      <span class="state pending">
                        <Spinner /> Activating
                      </span>
                    ) : link.state === "revoking" ? (
                      <span class="state pending">
                        <Spinner /> Revoking
                      </span>
                    ) : null}
                    {link.collection.deleted ? <span>inactive while in Trash</span> : null}
                    {isLive(link) ? (
                      link.expires_at === null ? (
                        <span class="soon">never expires</span>
                      ) : (
                        <span class={link.expires_at - now < DAY ? "soon" : undefined}>
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
        </main>
      </Layout>,
    ),
  );
}

export function previewHref(ctx: CollectionContext, path: string): string {
  return `${shellPath(ctx.collection.public_id, ctx.revision.public_id, path, ctx.pinned, ctx.revision.head_path)}?as=public`;
}
