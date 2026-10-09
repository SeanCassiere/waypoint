/** @jsxImportSource hono/jsx */
import type { Manifest } from "@waypoint/core";
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw as html } from "hono/html";
import type { Child } from "hono/jsx";

import type { Health } from "../../health.ts";
import type { HttpServices } from "../../http.ts";
import type { RevisionRow } from "../../read-model.ts";
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
/** The share dialog's preview link, when it opens the Latest URL. */
const PREVIEW_LATEST_TITLE = "Opens the Latest URL as a stranger sees it today";

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

export type RevisionWord = "synced" | "uploading" | "stalled" | "waiting" | "failed";
export interface DisclosedRevision {
  /** Display number. */
  n: number;
  publicId: string;
  word: RevisionWord;
  /** Manifest paths, head file first, then sorted (empty for the track's steps). */
  files: string[];
}
/** What each share target publishes, for the share dialog (OW-03). */
export interface ShareDisclosure {
  /** The revision the dialog was opened on: what "Only #N" publishes. */
  current: DisclosedRevision;
  /** What a Latest link shows now (ctx.publicSees). */
  newestSynced: DisclosedRevision | null;
  /** ctx.latest when it is newer than newestSynced and not synced: what Latest shows next. */
  next: DisclosedRevision | null;
  /** Every revision newer than newestSynced, in display order (failed and unsynced alike). */
  steps: DisclosedRevision[];
  /** RX-11's rule: a revision that isn't failed or synced is newer than newestSynced. */
  syncing: boolean;
  hrefs: { latest: string; pinned: string };
}

/**
 * One revision's sync word: FC2's precomputed health for a queued revision (already
 * "uploading" instead of "stalled" with sync off); a committed one isn't public yet, so it
 * counts as uploading.
 */
export function revisionWord(row: RevisionRow, health: Health): RevisionWord {
  if (row.sync_state === "failed") return "failed";
  if (row.sync_state === "committed") return "uploading";
  if (row.sync_state === "pending")
    return health.pending.find((item) => item.id === row.id)?.sync ?? "uploading";
  return "synced";
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A manifest's paths: the head file first, then the rest sorted. */
function manifestPaths(manifest: Manifest): string[] {
  const rest = Object.keys(manifest.files)
    .filter((p) => p !== manifest.headPath)
    .toSorted(byPath);
  return manifest.files[manifest.headPath] ? [manifest.headPath, ...rest] : rest;
}

/**
 * The Latest URL opening `path` when the newest synced revision has it, else that revision's
 * head file. The Latest URL resolves a bare `/c/{pub}/` to ctx.latest's head file, not the
 * synced one's (collection/index.tsx, then public-preview.tsx), so the file is named in the URL
 * unless it is ctx.latest's head: otherwise a newer revision that changes the head file would
 * make the preview open a different file.
 */
function latestHref(ctx: CollectionContext, path: string, synced: RevisionRow, has: boolean) {
  const file = has ? path : synced.head_path;
  return `${shellPath(ctx.collection.public_id, ctx.revision.public_id, file, false, ctx.latest?.head_path)}?as=public`;
}

/**
 * The newest synced revision's manifest per page context, recorded by shareDisclosure so the
 * synchronous previewHref(…, "latest") can apply the same path rule as hrefs.latest.
 */
const syncedManifests = new WeakMap<CollectionContext, Manifest>();

/** The newest synced manifest when it is known without a query. */
function knownSyncedManifest(ctx: CollectionContext): Manifest | undefined {
  if (ctx.publicSees?.id === ctx.revision.id) return ctx.manifest;
  return syncedManifests.get(ctx);
}

/**
 * The share dialog's data: the revision "Only #N" publishes, what a Latest link shows now and
 * next, and the steps between. At most two manifest queries, constant in history length.
 */
export async function shareDisclosure(
  ctx: CollectionContext,
  path: string,
): Promise<ShareDisclosure> {
  const { health } = ctx.chrome;
  const synced = ctx.publicSees;
  const after = synced?.display_number ?? 0;
  const latest = ctx.latest;
  const next =
    latest &&
    latest.sync_state !== "synced" &&
    latest.sync_state !== "failed" &&
    (latest.display_number ?? 0) > after
      ? latest
      : undefined;
  const manifestOf = (row: RevisionRow | undefined) =>
    !row
      ? Promise.resolve(undefined)
      : row.id === ctx.revision.id
        ? Promise.resolve(ctx.manifest)
        : ctx.s.reads.manifestOf(row);
  const [syncedManifest, nextManifest] = await Promise.all([manifestOf(synced), manifestOf(next)]);
  if (syncedManifest) syncedManifests.set(ctx, syncedManifest);
  const disclose = (row: RevisionRow, manifest?: Manifest): DisclosedRevision => ({
    n: row.display_number ?? 0,
    publicId: row.public_id,
    word: revisionWord(row, health),
    files: manifest ? manifestPaths(manifest) : [],
  });
  const steps = ctx.rows
    .filter((row) => (row.display_number ?? 0) > after)
    .toSorted((a, b) => (a.display_number ?? 0) - (b.display_number ?? 0))
    .map((row) => disclose(row));
  const pub = ctx.collection.public_id;
  return {
    current: disclose(ctx.revision, ctx.manifest),
    newestSynced: synced ? disclose(synced, syncedManifest) : null,
    next: next ? disclose(next, nextManifest) : null,
    steps,
    syncing: steps.some((step) => step.word !== "failed"),
    hrefs: {
      latest: synced
        ? latestHref(ctx, path, synced, Boolean(syncedManifest?.files[path]))
        : `/c/${pub}/?as=public`,
      pinned: `${shellPath(pub, ctx.revision.public_id, path, true, ctx.revision.head_path)}?as=public`,
    },
  };
}

/** Chip class and icon per word (VS-03: synced okcircle, failed alert, pending states clock). */
const OK_ICON = icon("okcircle", "sm");
const CLOCK_ICON = icon("clock", "sm");
const CHIP: Record<RevisionWord, readonly [string, string]> = {
  synced: ["ok", OK_ICON],
  failed: ["f", icon("alert", "sm")],
  uploading: ["p", CLOCK_ICON],
  stalled: ["p", CLOCK_ICON],
  waiting: ["w", CLOCK_ICON],
};

/** One step chip: "#5 now", "#7 uploading", or a struck "#6 failed". */
function StepChip(props: { rev: DisclosedRevision; now?: boolean; bare?: boolean }) {
  const { rev } = props;
  const [cls, mark] = CHIP[props.now ? "synced" : rev.word];
  const text = props.now ? `#${rev.n} now` : props.bare ? `#${rev.n}` : `#${rev.n} ${rev.word}`;
  return (
    <span class={`sc ${cls}`}>
      {html(mark)}
      {rev.word === "failed" ? <s>{text}</s> : text}
    </span>
  );
}

/** The "Public sees" track of one target: chips joined by chevrons, then one sentence. */
function Track(props: { target: "only" | "latest"; warn: boolean; chips: Child[]; note: string }) {
  return (
    <div
      class={`track when-${props.target}`}
      role="note"
      data-track={props.target}
      data-warn={props.warn ? "" : undefined}
    >
      <span class="lab">Public sees</span>
      {props.chips.flatMap((chip, i) =>
        i
          ? [
              <span class="to" aria-hidden="true">
                {html(icon("chevronRight", "sm"))}
              </span>,
              chip,
            ]
          : [chip],
      )}
      <p class="tnote">{props.note}</p>
    </div>
  );
}

/**
 * At most four chips after "now": with more than four steps, the older ones collapse into a
 * leading "+N more" chip and the newest three stay (so `next` stays visible).
 */
function stepChips(steps: DisclosedRevision[]): Child[] {
  if (steps.length <= 4) return steps.map((step) => <StepChip rev={step} />);
  const shown = steps.slice(-3).map((step) => <StepChip rev={step} />);
  return [<span class="sc">+{steps.length - 3} more</span>, ...shown];
}

function LatestTrack(props: { d: ShareDisclosure }) {
  const { newestSynced: synced, next, steps, syncing } = props.d;
  if (!synced)
    return (
      <Track
        target="latest"
        warn
        chips={stepChips(steps)}
        note="Nothing in this collection has synced yet. The link won't work until it does."
      />
    );
  const chips = [<StepChip rev={synced} now />, ...stepChips(steps)];
  if (syncing && next)
    return (
      <Track
        target="latest"
        warn
        chips={chips}
        note={`Latest: shows the newest revision. While #${next.n} uploads, recipients see #${synced.n} with a syncing note.`}
      />
    );
  const failed = steps.at(-1);
  if (failed)
    return (
      <Track
        target="latest"
        warn
        chips={chips}
        note={`Latest: shows the newest revision that has synced. #${failed.n} failed to upload, so recipients see #${synced.n} until you retry it.`}
      />
    );
  return (
    <Track
      target="latest"
      warn={false}
      chips={chips}
      note={`Latest: shows the newest revision, now #${synced.n}.`}
    />
  );
}

function OnlyTrack(props: { d: ShareDisclosure }) {
  const { current } = props.d;
  if (current.word === "failed") return null;
  if (current.word === "synced")
    return (
      <Track
        target="only"
        warn={false}
        chips={[<StepChip rev={current} bare />]}
        note={`An Only #${current.n} link shows this revision. It won't change.`}
      />
    );
  return (
    <Track
      target="only"
      warn
      chips={[<StepChip rev={current} />]}
      note={`Until #${current.n} syncs, people with the link see “This link isn't available”.`}
    />
  );
}

const MARKS = {
  yes: icon("check"),
  no: icon("close"),
  bang: icon("alert"),
  later: icon("clock"),
} as const;

/** A checklist row: its mark (an icon) and its text. */
function SeesRow(props: {
  mark: "yes" | "no" | "bang" | "later";
  class?: string;
  children: Child;
}) {
  return (
    <div class={props.class ? `row ${props.class}` : "row"}>
      <span class={props.mark} aria-hidden="true">
        {html(MARKS[props.mark])}
      </span>
      <span>{props.children}</span>
    </div>
  );
}

/** The checklist lists paths in plain sorted order (DisclosedRevision.files is head-first). */
const sortedPaths = (files: string[]): string[] => files.toSorted(byPath);

/** The first six paths, then "· +N more". */
function FileList(props: { items: Child[] }) {
  const { items } = props;
  const shown = items.slice(0, 6).flatMap((item, i) => (i ? [" · ", item] : [item]));
  return (
    <span class="files">
      {shown}
      {items.length > 6 ? ` · +${items.length - 6} more` : null}
    </span>
  );
}

/** What a Latest link shows once `next` syncs: added paths first, then removed, then the rest. */
function NextFiles(props: { next: DisclosedRevision; now: DisclosedRevision | null }) {
  const files = sortedPaths(props.next.files);
  if (!props.now) return <FileList items={files} />;
  const was = sortedPaths(props.now.files);
  const before = new Set(was);
  const after = new Set(files);
  return (
    <FileList
      items={[
        ...files.filter((p) => !before.has(p)).map((p) => <span class="add">+ {p}</span>),
        ...was.filter((p) => !after.has(p)).map((p) => <span class="rm">− {p}</span>),
        ...files.filter((p) => before.has(p)),
      ]}
    />
  );
}

/**
 * One phone-summary sentence. The shown one wraps if a long count doesn't fit on one line; the
 * full sentence is also its title, and the checklist below spells it out.
 */
function SumSm(props: { target: "only" | "latest"; text: string }) {
  return (
    <span class={`when-${props.target}`} title={props.text}>
      {props.text}
    </span>
  );
}

/** "the file" or "3 files". */
const fileCount = (files: string[]): string =>
  files.length === 1 ? "the file" : `${files.length} files`;

/** Create a public link (4.15) and Link created (4.16): one dialog, two steps. */
export function ShareDialog(props: {
  ctx: CollectionContext;
  links: ShareView[];
  disclosure: ShareDisclosure;
}) {
  const { ctx, disclosure: d } = props;
  const { current, newestSynced: synced, next, hrefs } = d;
  const n = current.n;
  const latestN = ctx.latest?.display_number ?? n;
  const hosts = [
    ...new Set(ctx.timeline.map((row) => row.host).filter((host): host is string => Boolean(host))),
  ];
  const liveCount = props.links.filter(isLive).length;
  const failed = current.word === "failed";
  const external = html(icon("external", "sm"));
  const onlySum =
    current.files.length === 1
      ? `Title + the file in #${n}`
      : `Title + all ${current.files.length} files in #${n}`;
  const latestSum = synced
    ? `Title + ${fileCount(synced.files)} in #${synced.n} now, then every future revision`
    : "Title, then every future revision once one syncs";
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
            <div class="alt">
              <OnlyTrack d={d} />
              <LatestTrack d={d} />
            </div>
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
                <span class="sum-sm alt">
                  {failed ? null : <SumSm target="only" text={onlySum} />}
                  <SumSm target="latest" text={latestSum} />
                </span>
              </summary>
              <SeesRow mark="yes">
                The title <b>“{ctx.collection.title}”</b>
              </SeesRow>
              <div class="alt">
                {failed ? null : (
                  <div class="when-only">
                    <SeesRow mark="yes">
                      {current.files.length === 1 ? (
                        <>
                          <b>The file</b> in #{n}
                        </>
                      ) : (
                        <>
                          <b>
                            All {current.files.length} files in #{n}
                          </b>
                          , not just the one you're reading
                        </>
                      )}
                      <br />
                      <FileList items={sortedPaths(current.files)} />
                    </SeesRow>
                  </div>
                )}
                <div class="when-latest">
                  <SeesRow mark="yes">
                    {synced ? (
                      <>
                        <b>
                          Now: {fileCount(synced.files)} in #{synced.n}
                        </b>
                        <br />
                        <FileList items={sortedPaths(synced.files)} />
                      </>
                    ) : (
                      <>
                        <b>Now: nothing.</b> No revision has synced yet.
                      </>
                    )}
                  </SeesRow>
                  {next ? (
                    <SeesRow mark="later" class="next">
                      <b>
                        When #{next.n} syncs: {plural(next.files.length, "file")}
                      </b>
                      <br />
                      <NextFiles next={next} now={synced} />
                    </SeesRow>
                  ) : null}
                  <SeesRow mark="bang">
                    <b>Every future revision</b>, by any agent on{" "}
                    <span class="mono">{hosts.length ? hosts.join(", ") : "any machine"}</span>,
                    within seconds of syncing, with no review step
                  </SeesRow>
                </div>
              </div>
              <SeesRow mark="bang" class="when-never">
                <b>No expiry.</b> It stays public until you revoke it.
              </SeesRow>
              <SeesRow mark="no">
                <span class="muted">
                  Other revisions, revision messages, metadata, machine names, and your other
                  collections
                </span>
              </SeesRow>
            </details>
          </div>
          <div class="ft sticky">
            <span class="grow">
              <a
                class="alt"
                href={failed ? hrefs.latest : hrefs.pinned}
                target="_blank"
                rel="noopener"
                data-preview-for="target"
                data-latest={hrefs.latest}
                data-pinned={hrefs.pinned}
                title={failed ? PREVIEW_LATEST_TITLE : undefined}
              >
                <span class="when-latest">
                  Preview what this link shows
                  {synced ? (
                    <>
                      : <b>#{synced.n}</b>
                    </>
                  ) : null}{" "}
                  {external}
                </span>
                {failed ? null : (
                  <span class="when-only">
                    Preview #{n} as public {external}
                  </span>
                )}
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

/**
 * "Preview as public": with no target, the URL this page was opened on; "only" the pinned URL
 * of this revision; "latest" the Latest URL, which (like shareDisclosure's hrefs.latest) keeps
 * `path` only when the newest synced revision has it. That manifest is known when the newest
 * synced revision is the page's own, or once shareDisclosure has run for this context (every
 * page that renders the share dialog awaits it first). This helper is synchronous and
 * CollectionContext carries only the page revision's manifest, so before that it keeps `path`:
 * the public preview opens that file when the newest synced revision has it (the same URL as
 * hrefs.latest) and that revision's head file when it doesn't.
 */
export function previewHref(
  ctx: CollectionContext,
  path: string,
  target?: "latest" | "only",
): string {
  const pub = ctx.collection.public_id;
  if (target === "latest") {
    if (!ctx.publicSees) return `/c/${pub}/?as=public`;
    const known = knownSyncedManifest(ctx);
    return latestHref(ctx, path, ctx.publicSees, known ? Boolean(known.files[path]) : true);
  }
  const pinned = target === "only" || ctx.pinned;
  return `${shellPath(pub, ctx.revision.public_id, path, pinned, ctx.revision.head_path)}?as=public`;
}
