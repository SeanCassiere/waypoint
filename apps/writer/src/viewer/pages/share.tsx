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
  isPaused,
  linkPage,
  LINKS_PAGE,
  sharingEnabled,
  URL_UNAVAILABLE,
  type LinkFilter,
  type LinkPage,
  type ShareView,
} from "../../shares.ts";
import { shellPath } from "../../viewer-paths.ts";
import { getChrome } from "../chrome.ts";
import { Spinner, Time } from "../components.tsx";
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
        {html(icon("globe", "sm"))}
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

/**
 * Copy URL (the card's primary action) and Open, or why the URL can't be shown. `describedBy`
 * (a /links row's label id, OW-05b) describes each control; unset, no attribute renders.
 */
export function LinkUrlActions(props: {
  link: ShareView;
  sharing?: boolean;
  describedBy?: string;
}) {
  const { url } = props.link;
  const { describedBy } = props;
  // Without sharing configured, no URL can be derived for any link.
  if (props.sharing === false) return null;
  if (!url)
    return (
      <details class="why" data-url-missing>
        <summary class="chip xs" aria-describedby={describedBy}>
          URL unavailable {html(icon("info", "sm"))}
        </summary>
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
        aria-describedby={describedBy}
      >
        {html(icon("copy", "sm"))}
        Copy URL
      </button>
      <a
        class="btn sm ghost"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-open-url
        aria-describedby={describedBy}
      >
        Open
        {html(icon("external", "sm"))}
      </a>
    </>
  );
}

/**
 * A short, owner-only fingerprint of a link's URL (D50): "…/s/wps_Lfqv…/c/w1h0…", enough to tell
 * two links apart without showing the token. Null when the URL isn't a share URL.
 */
export function fingerprint(url: string): string | null {
  const [, token, pub] = /\/s\/([^/?#]+)\/c\/([^/?#]+)\//.exec(url) ?? [];
  if (!token || !pub) return null;
  return `…/s/${token.slice(0, 8)}…/c/${pub.slice(0, 4)}…`;
}

function LinkCard(props: {
  link: ShareView;
  now: number;
  newest: number | null;
  sharing: boolean;
}) {
  const { link, now } = props;
  // Live, waiting and paused cards keep their actions (OW-05).
  const open = isOpen(link);
  const soon = open && link.expires_at !== null && link.expires_at - now < DAY;
  const fp = link.url ? fingerprint(link.url) : null;
  return (
    <div class={`lnk${open ? "" : " dead"}`} data-link={link.id} data-link-status={link.status}>
      <div class="h">
        {link.label ? <b data-link-label>{link.label}</b> : <i data-link-label>No label</i>}
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
      </dl>
      {fp ? (
        <code class="fp" data-fp>
          {fp}
        </code>
      ) : null}
      <RevokeNote link={link} />
      {open ? (
        <>
          {props.sharing ? (
            <div class="row r1">
              <LinkUrlActions link={link} sharing={props.sharing} />
            </div>
          ) : null}
          {/* Extend… on any expiring open link (D48), Revoke… at the far end. */}
          <div class="row r2">
            {link.expires_at !== null ? (
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
            <span class="grow" />
            <details class="act">
              <summary class="txtbtn danger">Revoke…</summary>
              <div class="pop" role="group" aria-label="Confirm revoke">
                <span>
                  <b>Revoke this link?</b> People using it lose access within seconds. You can't
                  undo this.
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
        </>
      ) : null}
    </div>
  );
}

/**
 * The collection panel's Links tab (spec §4.17, reworked from owner feedback): one primary
 * action, a quiet secondary row, calm cards with Copy URL first, and "Revoke all" demoted to
 * a text action under the cards when there's more than one link to revoke. The nodes a revoke
 * changes carry data-refresh keys: the client swaps them from a re-fetch of the page (OW-04).
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
            {html(icon("globe"))}
            New public link
          </button>
        ) : (
          <p class="note">{KEY_MISSING}</p>
        )}
        <a class="txtbtn" href={props.previewHref} target="_blank" rel="noopener">
          Preview as public
          {html(icon("external", "sm"))}
        </a>
      </div>
      {live.map((link) => (
        <LinkCard link={link} now={ctx.chrome.now} newest={newest} sharing={ctx.sharing} />
      ))}
      {!live.length ? (
        <p class="legend" data-refresh="links-empty">
          No live links. Create one with Share.
        </p>
      ) : null}
      {live.length >= 2 ? (
        <div class="lnk-foot" data-refresh="links-foot">
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
        <details class="inactive" data-refresh="links-inactive">
          <summary>Show {dead.length} inactive</summary>
          {dead.map((link) => (
            <LinkCard link={link} now={ctx.chrome.now} newest={newest} sharing={ctx.sharing} />
          ))}
        </details>
      ) : null}
    </>
  );
}

/** A link as the status line names it. */
const linkName = (link: ShareView): string => (link.label ? `“${link.label}”` : "A link");

/**
 * The status line's public segment, over live links only: the one that follows latest, else the
 * one pinned link, else how many pinned links there are. Null when nothing is live.
 */
export function publicSegment(
  links: ShareView[],
): { tone: "public"; body: Child; text: string; brief: string } | null {
  const live = links.filter(isLive);
  if (!live.length) return null;
  const count = plural(live.length, "live link");
  const pubseg = <span class="pubseg">{html(icon("globe", "sm"))} Public</span>;
  const following = live.find((link) => !link.revision_id);
  if (following) {
    const who = linkName(following);
    return {
      tone: "public",
      text: `Public: ${count}. ${who} follows latest, so new revisions become public within seconds of syncing.`,
      brief: `Public: ${who} follows latest`,
      body: (
        <span>
          {pubseg} {count}. <b>{who} follows latest</b>
          <span class="long">, so new revisions become public within seconds of syncing.</span>
        </span>
      ),
    };
  }
  const [only] = live;
  if (live.length === 1 && only) {
    const shows = `${linkName(only)} shows only #${only.revision_display_number ?? "?"}`;
    return {
      tone: "public",
      text: `Public: ${count}. ${shows}; new revisions stay private.`,
      brief: `Public: ${shows}`,
      body: (
        <span>
          {pubseg} {count}. <b>{shows}</b>
          <span class="long">; new revisions stay private.</span>
        </span>
      ),
    };
  }
  return {
    tone: "public",
    text: `Public: ${count}, each pinned to one revision; new revisions stay private.`,
    brief: `Public: ${live.length} pinned links`,
    body: (
      <span>
        {pubseg} {count}
        <span class="long">, each pinned to one revision; new revisions stay private.</span>
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
          {html(icon("globe", "xl"))}
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
                <span class="sum-more" aria-hidden="true">
                  Details {html(icon("chevronDown", "sm"))}
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
          {html(icon("globe", "xl"))}
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
              Open {html(icon("external", "sm"))}
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

/** /links segments, in order: the filter key (FC1's), the visible label and the URL (OW-05b). */
const SEGMENTS = [
  ["active", "Live", "/links"],
  ["paused", "Paused in Trash", "/links?state=paused"],
  ["expired", "Expired", "/links?state=expired"],
  ["revoked", "Revoked", "/links?state=revoked"],
] as const;
/** A paused row's note: what recipients get, and what a restore does. */
const PAUSED_NOTE =
  "Answers “not available” while the collection is in Trash. Restoring asks before it works again.";

/** `?state=` as a filter: `live` is an alias of `active` (the Live segment), anything else too. */
function linkFilter(raw: string | undefined): LinkFilter {
  if (
    raw === "paused" ||
    raw === "waiting" ||
    raw === "expired" ||
    raw === "revoked" ||
    raw === "inactive"
  )
    return raw;
  return "active";
}

/** The header: how many links on how many collections the reader serves right now. */
function LinksHead(props: { counts: LinkPage["counts"] }) {
  const { active, collections, soon } = props.counts;
  if (!active) return <>Nothing is readable outside your tailnet right now.</>;
  const expiring = soon ? ` ${soon} ${soon === 1 ? "expires" : "expire"} within a day.` : "";
  return (
    <>
      <b>
        {plural(active, "link")} on {plural(collections, "collection")}
      </b>
      {` ${active === 1 ? "is" : "are"} readable outside your tailnet right now.${expiring} Revoking takes effect within seconds.`}
    </>
  );
}

/** Extend… on a /links row: the Links tab card's +7 days / +30 days confirmation. */
function ExtendAct(props: { link: ShareView; expires: number; describedBy: string }) {
  const { link, describedBy } = props;
  return (
    <details class="act">
      <summary class="txtbtn" aria-describedby={describedBy}>
        Extend…
      </summary>
      <div class="pop neutral" role="group" aria-label="Extend this link">
        <span>Keep this link working longer. The new expiry reaches viewers within seconds.</span>
        <span class="row">
          <button
            type="button"
            class="btn sm"
            data-action="close-details"
            aria-describedby={describedBy}
          >
            Keep as is
          </button>
          {(["7", "30"] as const).map((days) => (
            <button
              type="button"
              class="btn sm"
              data-action="extend-link"
              data-id={link.id}
              data-days={days}
              data-from={String(props.expires)}
              aria-describedby={describedBy}
            >
              +{days} days
            </button>
          ))}
        </span>
      </div>
    </details>
  );
}

/** A live or waiting row's expiry: a clock and ink at 600 within a day (never amber). */
function RowExpiry(props: { expires: number | null; now: number }) {
  const { expires, now } = props;
  if (expires === null) return <span data-live>never expires</span>;
  if (expires - now < DAY)
    return (
      <span class="soon" data-live>
        {html(icon("clock", "sm"))}
        expires <Time at={expires} fmt="until" now={now} />
      </span>
    );
  return (
    <span data-live>
      expires <Time at={expires} fmt="until" now={now} />
    </span>
  );
}

/** "Opens when #7 syncs": the pinned revision, or for Latest the collection's newest. */
function opensWhen(link: ShareView): string {
  const number = link.revision_id
    ? link.revision_display_number
    : link.collection.latest_display_number;
  return number === null ? "Opens when a revision syncs" : `Opens when #${number} syncs`;
}

/**
 * One /links row (OW-05b): the label (which describes every action), the actions for an open
 * link (a paused one can only be revoked), then the target, the state, the fingerprint and
 * when it was made.
 */
function LinkRow(props: { link: ShareView; now: number; sharing: boolean }) {
  const { link, now } = props;
  const open = isOpen(link);
  const paused = isPaused(link);
  const described = `lw-${link.id}`;
  const fp = link.url ? fingerprint(link.url) : null;
  return (
    <li class={`lrow${open ? "" : " dead"}`} data-link={link.id} data-link-status={link.status}>
      <span class="who" id={described}>
        {link.label ? <b data-link-label>{link.label}</b> : <i data-link-label>No label</i>}
      </span>
      {open ? (
        <span class="acts">
          {paused ? null : (
            <>
              <LinkUrlActions link={link} sharing={props.sharing} describedBy={described} />
              {link.expires_at !== null ? (
                <ExtendAct link={link} expires={link.expires_at} describedBy={described} />
              ) : (
                <span class="slot" aria-hidden="true" />
              )}
            </>
          )}
          <button
            type="button"
            class="txtbtn danger"
            data-action="revoke-link"
            data-id={link.id}
            data-confirm="true"
            aria-describedby={described}
          >
            Revoke…
          </button>
        </span>
      ) : null}
      <span class="s">
        <span class={`chip xs${link.revision_id ? "" : " public"}`} data-shows>
          {link.revision_id ? null : html(icon("globe", "sm"))}
          {showsText(link, null)}
        </span>
        {paused ? (
          <>
            <span class="chip xs" data-link-state="paused">
              Paused
            </span>
            {/* data-live: a revoke removes it (a revoked link never works again). */}
            <span data-live>{PAUSED_NOTE}</span>
          </>
        ) : open ? (
          <>
            {link.status === "waiting" ? (
              <span class="chip xs waiting" data-link-state="waiting">
                {html(icon("clock", "sm"))}
                {opensWhen(link)}
              </span>
            ) : null}
            <RowExpiry expires={link.expires_at} now={now} />
          </>
        ) : (
          <>
            {link.revoked_at !== null ? (
              <span>
                revoked <Time at={link.revoked_at} fmt="ago" now={now} />
              </span>
            ) : link.expires_at !== null ? (
              <span>
                expired <Time at={link.expires_at} fmt="date" now={now} />
              </span>
            ) : null}
            <RevokeNote link={link} inline />
          </>
        )}
        {fp ? (
          <code class="fp" data-fp>
            {fp}
          </code>
        ) : null}
        <span>
          created <Time at={link.created_at} fmt="day" now={now} />
        </span>
      </span>
    </li>
  );
}

/** This page's rows by collection, in order of each collection's first (newest) row. */
function groupByCollection(views: ShareView[]): ShareView[][] {
  const groups = new Map<string, ShareView[]>();
  for (const view of views) {
    const group = groups.get(view.collection.id);
    if (group) group.push(view);
    else groups.set(view.collection.id, [view]);
  }
  return [...groups.values()];
}

/** A collection's links on /links: its title, project and newest revision, and where to manage. */
function LinkGroup(props: {
  links: ShareView[];
  index: number;
  inTrash: boolean;
  now: number;
  sharing: boolean;
}) {
  const first = props.links[0];
  if (!first) return null;
  const { collection } = first;
  const heading = `lg-${props.index}`;
  // A collection gone from underneath its links: no title, nothing to link to.
  const known = Boolean(collection.public_id && collection.title);
  const number =
    collection.latest_display_number === null ? null : `now #${collection.latest_display_number}`;
  const meta = [collection.project, number].filter(Boolean).join(" · ");
  return (
    <section class="lgrp" aria-labelledby={heading} data-collection={collection.id}>
      <header class="lgh">
        <h2 id={heading}>
          {known ? (
            <a href={`/c/${collection.public_id}/`}>{collection.title}</a>
          ) : (
            "Unknown collection"
          )}
        </h2>
        {meta ? <span class="p">{meta}</span> : null}
        <span class="grow" />
        {!known ? null : props.inTrash || collection.deleted ? (
          <a class="tab" href="/trash">
            Trash
          </a>
        ) : (
          <a class="tab" href={`/c/${collection.public_id}/?panel=links`}>
            Links tab
          </a>
        )}
      </header>
      <ul class="lrows">
        {props.links.map((link) => (
          <LinkRow link={link} now={props.now} sharing={props.sharing} />
        ))}
      </ul>
    </section>
  );
}

/**
 * /links: every public link across collections (spec §5.7, OW-05b). Segments by FC1's live rule
 * (Live counts only links the reader serves; waiting links are listed there, not counted), rows
 * grouped by collection, and a header that says how much is readable right now. The nodes a
 * revoke changes carry data-refresh keys, so they follow a re-fetch of the page (OW-04).
 */
export async function linksPage(s: HttpServices, c: Context): Promise<Response> {
  const now = Date.now();
  const filter = linkFilter(c.req.query("state"));
  // One page at a time, counted in SQL: prod-sized link lists made this page megabytes.
  const chrome = await getChrome(s, now);
  const {
    views: shown,
    counts,
    remaining,
    next,
  } = await linkPage(s, filter, c.req.query("after"), now, chrome.trashedPending);
  const sharing = sharingEnabled(s);
  const live = filter === "active";
  return noStore(
    c.html(
      <Layout
        title="Public links"
        chrome={chrome}
        bar={<HomeBar chrome={chrome} current="links" />}
        page="links"
      >
        <main class="wrap" id="main" data-links-page>
          <div class="ph">
            <div>
              <h1>{html(icon("globe", "xl"))} Public links</h1>
              <p data-refresh="links-head">
                <LinksHead counts={counts} />
              </p>
              {sharing ? null : <p class="note">{KEY_MISSING}</p>}
            </div>
          </div>
          <nav class="seg" aria-label="Link state" data-refresh="links-seg">
            {SEGMENTS.map(([key, label, href]) => (
              <a href={href} aria-current={key === filter ? "page" : undefined}>
                {label}{" "}
                <span class="n" data-count-of={key}>
                  {counts[key]}
                </span>
              </a>
            ))}
          </nav>
          {live && counts.paused ? (
            <p class="legend" data-refresh="links-paused">
              {counts.paused === 1
                ? "1 paused link on a collection in Trash isn't counted."
                : `${counts.paused} paused links on collections in Trash aren't counted.`}{" "}
              <a href="/links?state=paused">
                Show
                {html(icon("chevronRight", "sm"))}
              </a>
            </p>
          ) : null}
          {shown.length ? (
            groupByCollection(shown).map((links, index) => (
              <LinkGroup
                links={links}
                index={index + 1}
                inTrash={filter === "paused"}
                now={now}
                sharing={sharing}
              />
            ))
          ) : (
            <div class="empty">
              {live
                ? "No public links. Nothing is readable outside your tailnet."
                : `No ${filter} links.`}
            </div>
          )}
          {live && counts.active >= 2 ? (
            <div class="lnk-foot lc-foot" data-refresh="links-foot">
              <span>
                Expired and revoked links stay listed under their tabs; they can't be turned back
                on.
              </span>
              <button
                type="button"
                class="txtbtn danger"
                data-action="revoke-all"
                data-count={String(counts.active)}
                data-noun="live links"
              >
                Revoke all {counts.active} live links…
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
