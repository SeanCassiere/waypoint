/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import { shellPath } from "../../../viewer-paths.ts";
import { RevisionNode, StateGlyph, Time } from "../../components.tsx";
import { changesHref, type CollectionContext } from "./shell.tsx";

export interface Segment {
  tone: "failed" | "pending" | "public" | "info";
  body: Child;
  /** Plain text of the segment: the phone line's one tap target speaks it (spec §4.12). */
  text: string;
  /** The segment without its long explanation: what the phone line shows. */
  brief?: string;
  /** The "older revision" segment, which goes last (spec order). */
  older?: boolean;
}
export function statusSegments(ctx: CollectionContext): {
  segments: Segment[];
  action: Child | null;
} {
  const { rows, revision, latest, publicSees, collection } = ctx;
  const segments: Segment[] = [];
  let action: Child | null = null;
  const failed = rows.filter((row) => row.sync_state === "failed");
  const pending = rows.filter((row) => row.sync_state === "pending");
  const sees = publicSees ? `#${publicSees.display_number}` : "nothing yet";
  if (rows.length && failed.length === rows.length) {
    segments.push({
      tone: "failed",
      text: "Nothing in this collection has synced. It exists only on this writer.",
      brief: "Nothing in this collection has synced.",
      body: (
        <span>
          <span class="f">
            <StateGlyph kind="failed" /> Nothing in this collection has synced.
          </span>{" "}
          <span class="long">It exists only on this writer.</span>
        </span>
      ),
    });
    action = (
      <button
        type="button"
        class="btn sm"
        data-action="retry"
        data-ids={failed.map((row) => row.id).join(",")}
        data-n={failed.length === 1 ? failed[0]?.display_number : undefined}
      >
        Retry all
      </button>
    );
    return { segments, action };
  }
  if (revision.sync_state === "failed") {
    // The raw error lives in the History row and on Status; the line stays short (§4.12).
    segments.push({
      tone: "failed",
      text: `#${revision.display_number} failed to sync. Readable on this writer only.`,
      brief: `#${revision.display_number} failed to sync.`,
      body: (
        <span>
          <span class="f">
            <StateGlyph kind="failed" /> #{revision.display_number} failed to sync.
          </span>{" "}
          <span class="long">Readable on this writer only.</span>{" "}
          <a href={`/status#${revision.id}`}>Details</a>
        </span>
      ),
    });
    action = (
      <>
        <button
          type="button"
          class="btn sm"
          data-action="retry"
          data-ids={revision.id}
          data-n={revision.display_number}
        >
          Retry
        </button>
        <button
          type="button"
          class="btn sm danger"
          data-action="drop"
          data-id={revision.id}
          data-n={revision.display_number}
        >
          Drop…
        </button>
      </>
    );
  } else if (failed.length) {
    const first = failed.at(-1)!;
    const list = failed.map((row) => `#${row.display_number}`).join(", ");
    segments.push({
      tone: "failed",
      text: `${list} failed to sync`,
      body: (
        <span class="f">
          <StateGlyph kind="failed" /> {list} failed to sync
        </span>
      ),
    });
    action = (
      <button
        type="button"
        class="btn sm"
        data-action="retry"
        data-ids={first.id}
        data-n={first.display_number}
      >
        Retry #{first.display_number}
      </button>
    );
  }
  if (revision.sync_state === "pending")
    segments.push({
      tone: "pending",
      text: `#${revision.display_number} is uploading. Readable here; other machines and public links see ${sees}.`,
      brief: `#${revision.display_number} is uploading.`,
      body: (
        <span>
          <span class="p">
            <StateGlyph kind="pending" /> #{revision.display_number} is uploading.
          </span>{" "}
          <span class="long">Readable here; other machines and public links see {sees}.</span>
        </span>
      ),
    });
  else if (pending.length) {
    const list = pending.map((row) => `#${row.display_number}`).join(", ");
    segments.push({
      tone: "pending",
      text: `${list} uploading`,
      body: (
        <span class="p">
          <StateGlyph kind="pending" /> {list} uploading
        </span>
      ),
    });
  }
  if ((failed.length || pending.length) && revision.sync_state !== "pending")
    segments.push({
      tone: "info",
      text: `Other machines and public links see ${sees}.`,
      body: <span class="long">Other machines and public links see {sees}.</span>,
    });
  if (ctx.pinned && latest && revision.id !== latest.id && revision.sync_state !== "failed") {
    const viewing = revision.display_number ?? 0;
    const later = (latest.display_number ?? 0) > viewing;
    segments.push({
      tone: "info",
      older: true,
      text: `You're viewing #${viewing}, not the latest. Latest is #${latest.display_number}.`,
      brief: `You're viewing #${viewing}, not the latest. Latest is #${latest.display_number}`,
      body: (
        <span>
          <span data-older-segment hidden />
          You're viewing #{viewing}, not the latest.{" "}
          <a href={`/c/${collection.public_id}/`}>Latest is #{latest.display_number}</a>
          {later ? (
            <span class="long">
              {" "}
              <a
                href={`${shellPath(collection.public_id, latest.public_id, "", true)}changes?base=${revision.public_id}`}
              >
                See changes since #{viewing}
              </a>
            </span>
          ) : null}
        </span>
      ),
    });
  }
  return { segments, action };
}

/** Segments as one spoken sentence: each ends in a full stop, so no separator is needed. */
const sentence = (parts: readonly string[]): string =>
  parts.map((part) => part.trim().replace(/[.:;,]?$/, ".")).join(" ");

/** The state notice beside the panel tabs (spec §4.12, Logbook): state glyphs and words, no dot
 *  between segments; beside the tabs (≥ 1100 px) the long clauses drop out and the whole sentence
 *  stays in the tap target's label. `strip`: the page has a revision strip, which says "not the
 *  latest" instead of the notice. */
export function StatusLine(props: { ctx: CollectionContext; extra?: Segment[]; strip?: boolean }) {
  const found = statusSegments(props.ctx);
  const segments = found.segments.filter((segment) => !(props.strip && segment.older));
  const { action } = found;
  // Spec order: failed, uploading, public, new since last read, then the older revision.
  const older = segments.findIndex((segment) => segment.older);
  const extra = props.extra ?? [];
  const all =
    older < 0
      ? [...segments, ...extra]
      : [...segments.slice(0, older), ...extra, ...segments.slice(older)];
  const tone = all.find((segment) => segment.tone === "failed")
    ? "failed"
    : all.find((segment) => segment.tone === "pending")
      ? "pending"
      : all.find((segment) => segment.tone === "public")
        ? "public"
        : "info";
  const spoken = sentence(all.map((segment) => segment.text));
  const brief = sentence(all.map((segment) => segment.brief ?? segment.text));
  const tab = all.every((segment) => segment.tone === "public") ? "links" : "history";
  return (
    <div class={`status1 ${tone}`} data-status role="status" hidden={!all.length}>
      <a
        class="stap"
        href={`?panel=${tab}`}
        data-action="panel-tab"
        data-tab={tab}
        data-status-tap
        aria-label={`${spoken} Open ${tab === "links" ? "Public links" : "History"}.`}
      >
        {brief}
      </a>
      {all.map((segment) => (
        <span class="seg1">{segment.body}</span>
      ))}
      <span class="grow" />
      {action}
    </div>
  );
}

/** The revision strip above the document (Logbook): which revision this is, who wrote it and
 *  when, its message, and the way to its changes, from what the page already has. On an older
 *  revision it also says "Not the latest." with the way to the latest and the changes since. */
export function RevisionStrip(props: { ctx: CollectionContext }) {
  const { ctx } = props;
  const { revision, latest, collection } = ctx;
  const row = ctx.byId.get(revision.id);
  const n = revision.display_number ?? 0;
  const parent = revision.parent_revision_id
    ? ctx.byId.get(revision.parent_revision_id)
    : undefined;
  const older =
    ctx.pinned && latest && revision.id !== latest.id && revision.sync_state !== "failed"
      ? latest
      : undefined;
  const later = older && (older.display_number ?? 0) > n;
  return (
    <div class="rstrip" data-strip>
      <RevisionNode state={revision.sync_state ?? "synced"} here />
      <span class="rs-what">
        <b>Revision {n}</b>, written {row?.host ? `by ${row.host} ` : ""}
        <Time at={revision.created_at} fmt="at" now={ctx.chrome.now} />
      </span>
      {revision.message ? <span class="rs-msg">{revision.message}</span> : null}
      {older ? (
        <span class="rs-older">
          <b>Not the latest.</b>
          <a href={`/c/${collection.public_id}/`}>Latest is #{older.display_number}</a>
          {later ? (
            <a
              href={`${shellPath(collection.public_id, older.public_id, "", true)}changes?base=${revision.public_id}`}
            >
              Changes since #{n}
            </a>
          ) : null}
        </span>
      ) : null}
      {row && parent ? (
        <a class="rs-changes" href={changesHref(ctx)(row, parent)}>
          Changes from #{parent.display_number}
        </a>
      ) : null}
    </div>
  );
}
