/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import { shellPath } from "../../../viewer-paths.ts";
import type { CollectionContext } from "./shell.tsx";

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
      text: "! Nothing in this collection has synced. It exists only on this writer.",
      brief: "! Nothing in this collection has synced.",
      body: (
        <span>
          <span class="f">! Nothing in this collection has synced.</span>{" "}
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
      text: `! #${revision.display_number} failed to sync. Readable on this writer only.`,
      brief: `! #${revision.display_number} failed to sync.`,
      body: (
        <span>
          <span class="f">! #{revision.display_number} failed to sync.</span>{" "}
          <span class="long">Readable on this writer only.</span>{" "}
          <a href={`/status#${revision.id}`}>Details</a>
        </span>
      ),
    });
    action = (
      <>
        <button type="button" class="btn sm" data-action="retry" data-ids={revision.id}>
          Retry
        </button>
        <button type="button" class="btn sm danger" data-action="drop" data-id={revision.id}>
          Drop…
        </button>
      </>
    );
  } else if (failed.length) {
    const first = failed.at(-1)!;
    const list = failed.map((row) => `#${row.display_number}`).join(", ");
    segments.push({
      tone: "failed",
      text: `! ${list} failed to sync`,
      body: <span class="f">! {list} failed to sync</span>,
    });
    action = (
      <button type="button" class="btn sm" data-action="retry" data-ids={first.id}>
        Retry #{first.display_number}
      </button>
    );
  }
  if (revision.sync_state === "pending")
    segments.push({
      tone: "pending",
      text: `◌ #${revision.display_number} is uploading. Readable here; other machines and public links see ${sees}.`,
      brief: `◌ #${revision.display_number} is uploading.`,
      body: (
        <span>
          <span class="p">◌ #{revision.display_number} is uploading.</span>{" "}
          <span class="long">Readable here; other machines and public links see {sees}.</span>
        </span>
      ),
    });
  else if (pending.length) {
    const list = pending.map((row) => `#${row.display_number}`).join(", ");
    segments.push({
      tone: "pending",
      text: `◌ ${list} uploading`,
      body: <span class="p">◌ {list} uploading</span>,
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
      brief: `You're viewing #${viewing}, not the latest. Latest is #${latest.display_number} →`,
      body: (
        <span>
          <span data-older-segment hidden />
          You're viewing #{viewing}, not the latest.{" "}
          <a href={`/c/${collection.public_id}/`}>Latest is #{latest.display_number} →</a>
          {later ? (
            <span class="long">
              {" · "}
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

export function StatusLine(props: { ctx: CollectionContext; extra?: Segment[] }) {
  const { segments, action } = statusSegments(props.ctx);
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
  const text = all.map((segment) => segment.text).join(" · ");
  const brief = all.map((segment) => segment.brief ?? segment.text).join(" · ");
  // The visible glyphs (! ◌) are markers, not words; the tap target's name drops them.
  const spoken = text.replace(/(^|· )[!◌●] /g, "$1").replace(/\.?$/, ".");
  const tab = all.every((segment) => segment.tone === "public") ? "links" : "history";
  return (
    <div class={`status1 ${tone}`} data-status role="status" hidden={!all.length}>
      <a
        class="stap"
        href={`?panel=${tab}`}
        data-action="panel-tab"
        data-tab={tab}
        data-status-tap
        aria-label={`${spoken} Open ${tab === "links" ? "Links" : "History"}.`}
      >
        {brief}
      </a>
      {all.map((segment, index) => (
        <>
          {index ? (
            <span class="sepdot" aria-hidden="true">
              ·
            </span>
          ) : null}
          <span class="seg1">{segment.body}</span>
        </>
      ))}
      <span class="grow" />
      {action}
    </div>
  );
}
