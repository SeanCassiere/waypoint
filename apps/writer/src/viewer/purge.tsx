/** @jsxImportSource hono/jsx */
// A queued purge as Trash, Status and the in-Trash page show it (OW-14): its real step
// (bucket › database › files), why it is where it is, and the links its confirmation revoked.
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";

import { LocalSyncClient } from "../db.ts";
import type { HttpServices } from "../http.ts";
import type { PurgingCollection, RevisionRow } from "../read-model.ts";
import { Time } from "./components.tsx";

export type PurgeKind = "running" | "waiting" | "retrying";
export interface PurgeState {
  step: 1 | 2 | 3;
  kind: PurgeKind;
  nextAt: number | null;
}

/** UI step (pending_purges.step + 1) and state: an error retries; step 3 after a grace wait waits. */
export function purgeState(row: PurgingCollection, now: number): PurgeState {
  const step = row.step <= 0 ? 1 : row.step === 1 ? 2 : 3;
  const nextAt = row.next_attempt_at;
  if (row.last_error) return { step, kind: "retrying", nextAt };
  if (step === 3 && nextAt !== null && nextAt > now) return { step, kind: "waiting", nextAt };
  return { step, kind: "running", nextAt };
}

/** A link the purge's confirmation revoked (only while the collection's rows exist, steps 1–2). */
export interface PurgeLink {
  label: string | null;
  revision_display_number: number | null;
  revoked_at: number;
  /** syncLoop.pushedAt(revoked_at); null while not pushed or when sync is off. */
  pushed_at: number | null;
}

/** How long before the purge's requested_at its accept revoked the open links. */
const REVOKED_WITHIN_MS = 5_000;

/**
 * The links each purge's accept revoked, by collection ID: one share_links query for every
 * purge at steps 1–2 (step 3 has no rows left) and, when a link is pinned, one revisionIndex.
 */
export async function purgeLinks(
  s: HttpServices,
  rows: readonly PurgingCollection[],
): Promise<Map<string, PurgeLink[]>> {
  const result = new Map<string, PurgeLink[]>();
  const requested = new Map(
    rows.filter((row) => row.step <= 1).map((row) => [row.collection_id, row.requested_at]),
  );
  if (!requested.size) return result;
  const ids = [...requested.keys()];
  const links = await s.waypoint.all<{
    collection_id: string;
    revision_id: string | null;
    label: string | null;
    expires_at: number | null;
    revoked_at: number;
  }>(
    `SELECT collection_id,revision_id,label,expires_at,revoked_at FROM share_links WHERE revoked_at IS NOT NULL AND collection_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at,id`,
    ids,
  );
  const revoked = links.filter((link) => {
    const at = requested.get(link.collection_id) ?? 0;
    return (
      link.revoked_at <= at &&
      link.revoked_at >= at - REVOKED_WITHIN_MS &&
      (link.expires_at === null || link.expires_at > link.revoked_at)
    );
  });
  const pinned = [
    ...new Set(revoked.filter((link) => link.revision_id).map((link) => link.collection_id)),
  ];
  const index = pinned.length
    ? await s.reads.revisionIndex(pinned)
    : new Map<string, RevisionRow[]>();
  const syncOn = !(s.ingest.sync instanceof LocalSyncClient);
  for (const link of revoked) {
    const number = link.revision_id
      ? (index.get(link.collection_id)?.find((rev) => rev.id === link.revision_id)
          ?.display_number ?? null)
      : null;
    const list = result.get(link.collection_id) ?? [];
    list.push({
      label: link.label,
      revision_display_number: number,
      revoked_at: link.revoked_at,
      pushed_at: syncOn ? (s.syncLoop?.pushedAt(link.revoked_at) ?? null) : null,
    });
    result.set(link.collection_id, list);
  }
  return result;
}

const STEPS = ["Bucket", "Database, here and in the cloud", "Files only it used"] as const;

/** `Purging · step 2 of 3 · retrying` (Trash), `step 2 of 3` (Status), bold text in the banner. */
export function PurgeChip(props: {
  state: PurgeState;
  page: "trash" | "status" | "banner";
}): JSX.Element {
  const { state } = props;
  const retrying = state.kind === "retrying";
  const text = `step ${state.step} of 3${retrying ? " · retrying" : ""}`;
  if (props.page === "banner") return <b>Being purged · {text}</b>;
  return (
    <span class={`chip xs ${retrying ? "failed" : "pending"}`}>
      {raw(icon(retrying ? "alert" : "clock", "sm"))}
      {props.page === "trash" ? `Purging · ${text}` : text}
    </span>
  );
}

/** Bucket › Database › Files: done steps checked, the current one marked, later ones dashed. */
export function PurgeSteps(props: { state: PurgeState }): JSX.Element {
  const { state } = props;
  return (
    <ol class="steps" aria-label="Purge steps">
      {STEPS.map((name, index) => {
        const step = index + 1;
        if (step < state.step)
          return (
            <li class="done">
              {raw(icon("check", "sm"))}
              {name}
              <span class="vh"> (done)</span>
            </li>
          );
        if (step === state.step) {
          const bad = state.kind === "retrying";
          return (
            <li class={bad ? "now bad" : "now"} aria-current="step">
              {raw(icon(bad ? "alert" : "clock", "sm"))}
              {name}
            </li>
          );
        }
        return <li class="next">{name}</li>;
      })}
    </ol>
  );
}

const CAUSES = [
  "Deleting it from the bucket failed",
  "Removing it from the database failed",
  "Deleting its files failed",
] as const;
function cause(row: PurgingCollection, state: PurgeState): string {
  return `${CAUSES[state.step - 1] ?? CAUSES[0]} on attempt ${row.attempts}.`;
}
const RUNNING = [
  "Deleting it from the bucket. Nothing for you to do.",
  "Removed from the bucket. Now removing it from the database, here and in the cloud. Nothing for you to do.",
  "Removed from the bucket and the database. Now deleting the files only it used. Nothing for you to do.",
] as const;
/** Steps 1 and 3 touch the bucket; step 2 the cloud database. */
function hint(state: PurgeState): string {
  return state.step === 2
    ? "the cloud database settings in the writer's env file"
    : "the bucket credentials in the writer's env file";
}

/** Trash's sentence: what is happening now, in the owner's terms. */
function trashSentence(row: PurgingCollection, state: PurgeState, now: number): Child {
  if (state.kind === "retrying")
    return (
      <>
        <b>{cause(row, state)}</b> The writer tries again{" "}
        {state.nextAt === null ? (
          "shortly"
        ) : (
          <>
            at <Time at={state.nextAt} now={now} />
          </>
        )}{" "}
        on its own; nothing for you to do unless this keeps happening.
      </>
    );
  if (state.kind === "waiting" && state.nextAt !== null)
    return (
      <>
        Removed from the bucket and the database. Waiting out a 15-minute safety window before
        deleting files written recently; next try <Time at={state.nextAt} now={now} />.
      </>
    );
  return RUNNING[state.step - 1];
}

/** Status's sentence: the rule behind a wait, or where to look when a step keeps failing. */
function statusSentence(row: PurgingCollection, state: PurgeState, now: number): Child {
  if (state.kind === "retrying")
    return (
      <>
        <b>{cause(row, state)}</b> The writer retries every 5–10 minutes; if this keeps failing,
        check {hint(state)}.
      </>
    );
  if (state.kind === "waiting" && state.nextAt !== null)
    return (
      <>
        <b>Waiting, not failing.</b> Files written in the last 15 minutes are kept that long in case
        an upload still needs them. Next try <Time at={state.nextAt} now={now} />, automatically.
      </>
    );
  return RUNNING[state.step - 1];
}

/** `link “Vendor debug”`, or the unlabelled link's mode. */
function linkName(link: PurgeLink): string {
  if (link.label) return `link “${link.label}”`;
  return link.revision_display_number === null
    ? "Latest link"
    : `Only #${link.revision_display_number} link`;
}
const SHOWN_LINKS = 3;
/** The revoked links' spans: at most three, then `+n more links`; nothing at step 3. */
function LinkSpans(props: {
  state: PurgeState;
  links: readonly PurgeLink[];
  syncEnabled: boolean;
  now: number;
}): JSX.Element | null {
  const { links, now } = props;
  if (props.state.step === 3) return null;
  if (!links.length) return <span>had no public links</span>;
  const more = links.length - SHOWN_LINKS;
  return (
    <>
      {links.slice(0, SHOWN_LINKS).map((link) => (
        <span>
          {linkName(link)}{" "}
          {!props.syncEnabled ? (
            <>
              revoked <Time at={link.revoked_at} now={now} />
            </>
          ) : link.pushed_at === null ? (
            "revoked here, not yet in the cloud"
          ) : (
            <>
              revoked <Time at={link.revoked_at} now={now} />, confirmed by the cloud{" "}
              <Time at={link.pushed_at} now={now} />
            </>
          )}
        </span>
      ))}
      {more > 0 ? <span>+{more} more links</span> : null}
    </>
  );
}

/**
 * One queued purge. On Trash its only control is Details on Status; on Status it is a row of
 * OW-06b's In progress list (`li.item.purging`, deliberately not `.srow`) that Trash links to.
 */
export function PurgeRow(props: {
  row: PurgingCollection;
  page: "trash" | "status";
  now: number;
  links: readonly PurgeLink[];
  syncEnabled: boolean;
  /** Status only: global pending_r2_deletes count, shown at step 3. */
  bucketDeletes?: number;
}): JSX.Element {
  const { row, now } = props;
  const state = purgeState(row, now);
  // Rows queued before the public_id column (and whose collection is gone) use the ID.
  const pub = row.public_id ?? row.collection_id;
  const trash = props.page === "trash";
  return (
    <li
      class="item purging"
      id={`purge-${pub}`}
      data-flash-target={trash ? row.collection_id : undefined}
      aria-busy="true"
    >
      <span class="t">
        <span class="tt" id={`pt-${pub}`}>
          {trash ? row.title : `Purging “${row.title}”`}
        </span>{" "}
        <PurgeChip state={state} page={props.page} />
      </span>
      <PurgeSteps state={state} />
      <p class="why">{trash ? trashSentence(row, state, now) : statusSentence(row, state, now)}</p>
      {!trash && state.kind === "retrying" ? (
        <p class="raw">
          {row.last_error} · attempt {row.attempts}
          {state.nextAt === null ? null : (
            <>
              {" "}
              · next <Time at={state.nextAt} now={now} />
            </>
          )}
        </p>
      ) : null}
      <p class="meta">
        <span>
          {trash ? "Purge confirmed" : "confirmed"} <Time at={row.requested_at} now={now} />
        </span>
        <LinkSpans state={state} links={props.links} syncEnabled={props.syncEnabled} now={now} />
        {!trash && state.step === 3 && props.bucketDeletes !== undefined ? (
          <span>bucket file deletes queued: {props.bucketDeletes} (all collections)</span>
        ) : null}
        <span class="mono">{pub}</span>
      </p>
      {trash ? (
        <span class="acts">
          <a class="btn sm ghost" href={`/status#purge-${pub}`} aria-describedby={`pt-${pub}`}>
            Details on Status
          </a>
        </span>
      ) : null}
    </li>
  );
}

/** The in-Trash page's banner while purging: it can't be restored, and where it is. */
export function PurgeBanner(props: { row: PurgingCollection; now: number }): JSX.Element {
  const state = purgeState(props.row, props.now);
  const pub = props.row.public_id ?? props.row.collection_id;
  return (
    <div class={`hero ${state.kind === "retrying" ? "bad" : "warn"}`} data-purge-banner>
      <span class="dot" aria-hidden="true" />
      <div>
        <PurgeChip state={state} page="banner" />
        <span>
          “{props.row.title}” can't be restored. Its public links were revoked when you confirmed.
        </span>
        <PurgeSteps state={state} />
        <a href={`/status#purge-${pub}`}>Details on Status</a>
      </div>
    </div>
  );
}
