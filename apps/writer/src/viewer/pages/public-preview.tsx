/** @jsxImportSource hono/jsx */
import { isTextMime, WAYPOINT_VERSION } from "@waypoint/core";
import { icon, isStageImage, PHONE_MAX, renderPublicShell } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";

import { collectionHealth } from "../../health.ts";
import type { RevisionRow } from "../../read-model.ts";
import { shellPath } from "../../viewer-paths.ts";
import { Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";
import { HomeBarLite, type CollectionContext } from "./collection/index.tsx";

export type PreviewBandKind = "pinned" | "latest-current" | "latest-syncing" | "latest-failed";
export interface PreviewBandRow {
  id: string;
  display_number: number;
  sync_state: "synced" | "committed" | "pending" | "failed";
}
export interface PreviewBand {
  kind: PreviewBandKind;
  first: string;
  second: string | null;
  short: string;
  /** "Back to #7": the revision the owner came from. */
  back: string;
}

/**
 * What the preview band says (owner decision h): which revision a Latest or Only link shows. A
 * Latest link shows the newest synced revision, whatever its line; `latestId` is the newest
 * revision that hasn't failed (`ctx.latest`), and the last row is the newest of any state.
 */
export function previewBand(input: {
  rows: readonly PreviewBandRow[];
  latestId: string | null;
  revision: PreviewBandRow;
  served: PreviewBandRow;
  pinned: boolean;
}): PreviewBand {
  const s = input.served.display_number;
  const back = `Back to #${input.revision.display_number}`;
  if (input.pinned)
    return {
      kind: "pinned",
      first: `An Only #${s} link shows this revision.`,
      second: "It won't change.",
      short: `Only #${s} links show this`,
      back,
    };
  const short = `Latest links show #${s}`;
  const latest = input.rows.find((row) => row.id === input.latestId);
  if (latest && latest.id !== input.served.id)
    return {
      kind: "latest-syncing",
      first: `A Latest link shows #${s}, the newest revision that has synced.`,
      second: `Recipients see a “newer version is being synced” note until #${latest.display_number} finishes uploading.`,
      short,
      back,
    };
  const newest = input.rows.at(-1);
  if (newest && newest.sync_state === "failed" && newest.display_number > s)
    return {
      kind: "latest-failed",
      first: `A Latest link shows #${s}, the newest revision that has synced.`,
      second: `#${newest.display_number} failed to upload.`,
      short,
      back,
    };
  return {
    kind: "latest-current",
    first: `A Latest link shows #${s}, the latest.`,
    second: null,
    short,
    back,
  };
}

/** A row's band fields; rows from the read model always carry a number and a state. */
function bandRow(row: RevisionRow): PreviewBandRow {
  return {
    id: row.id,
    display_number: row.display_number ?? 0,
    sync_state: row.sync_state ?? "synced",
  };
}

/**
 * ?as=public: the public reader's shell on the writer (spec §2, §9), so the preview matches
 * what a stranger sees. A latest URL previews the newest synced revision, like the reader; a
 * pinned URL previews that revision. Content that hasn't synced is never shown as public.
 */
export async function publicPreview(
  c: Context,
  ctx: CollectionContext,
  path: string,
): Promise<Response> {
  const served = ctx.pinned ? ctx.revision : ctx.publicSees;
  if (!served || served.sync_state !== "synced") return notPublicYet(c, ctx, served);
  const manifest =
    served.id === ctx.revision.id ? ctx.manifest : await ctx.s.reads.manifestOf(served);
  const paths = Object.keys(manifest.files).toSorted((a, b) =>
    a === manifest.headPath ? -1 : b === manifest.headPath ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  const current = manifest.files[path] ? path : manifest.headPath;
  // RX-04: the reader's document branches (image stage, download card), from the shown file.
  const entry = manifest.files[current];
  const shown = entry ? { mime: entry.mime, size: entry.size } : null;
  const href = (file: string) =>
    `${shellPath(ctx.collection.public_id, served.public_id, file, ctx.pinned, manifest.headPath)}?as=public`;
  const shell = renderPublicShell({
    title: ctx.collection.title,
    files: paths.map((file) => ({
      path: file,
      mime: manifest.files[file]?.mime,
      size: manifest.files[file]?.size,
    })),
    head: manifest.headPath,
    current,
    fileHref: href,
    frameBase: `/raw/r/${served.public_id}/`,
    updatedAt: ctx.pinned ? null : served.created_at,
    snapshotAt: ctx.pinned ? served.created_at : null,
    download: !shown || isTextMime(shown.mime) || shown.mime.startsWith("image/") ? null : shown,
    image: shown && isStageImage(shown.mime) ? shown : null,
    version: WAYPOINT_VERSION,
  });
  // Owner-only band, injected on the writer right after the skip link; the reader's own output
  // never contains it. Back goes to the revision the owner came from, not the served one.
  const back = shellPath(
    ctx.collection.public_id,
    ctx.revision.public_id,
    ctx.manifest.files[current] ? current : "",
    ctx.pinned,
    ctx.revision.head_path,
  );
  const band = previewBand({
    rows: ctx.rows.map(bandRow),
    latestId: ctx.latest?.id ?? null,
    revision: bandRow(ctx.revision),
    served: bandRow(served),
    pinned: ctx.pinned,
  });
  // The writer's CSP is only `frame-ancestors 'self'`, so an inline <style> is allowed here
  // (unlike on the reader, whose shell this otherwise is). It goes in the head, so the band is
  // the skip link's next sibling.
  const html = shell
    .replace("</head>", `<style>${BANNER_CSS}</style></head>`)
    .replace(/<a class="skip"[^>]*>[^<]*<\/a>/, (m) => `${m}${bandHtml(band, back)}`);
  return noStore(c.html(html));
}

/**
 * The band's markup. Lead, separator and text share one flex item, so the region reads as one
 * sentence ("Public preview · A Latest link…"); flex items would each be a line of its text.
 */
function bandHtml(band: PreviewBand, back: string): string {
  // The served number is emphasised (the first "#N" in the first sentence).
  const first = escapeAttr(band.first).replace(/#\d+/, (number) => `<b>${number}</b>`);
  const second = band.second ? `<span class="wp-pv-2"> ${escapeAttr(band.second)}</span>` : "";
  return (
    `<div class="wp-pv" role="region" aria-label="Public preview" data-preview-banner data-preview-band="${band.kind}"><div class="wp-pv-in">` +
    icon("globe") +
    `<span class="wp-pv-m"><b class="wp-pv-lead">Public preview</b><span class="wp-pv-sep"> · </span><span class="wp-pv-t"><span class="wp-pv-1">${first}</span>${second}<span class="wp-pv-s">${escapeAttr(band.short)}</span></span></span>` +
    `<a class="wp-pv-back" href="${escapeAttr(back)}">${icon("chevronLeft")}${escapeAttr(band.back)}</a>` +
    `</div></div>`
  );
}

// Shared tokens only (the shell doesn't load viewer.css). The column matches the letterhead's
// `.lh` (1120 px, 20 px; 14 px on phones), so the band's start lines up with the title.
const BANNER_CSS =
  ".wp-pv{flex:none;display:flex;min-height:40px;background:var(--public-bg);border-bottom:1px solid var(--public-line);color:var(--ink-2);font:13px/1.4 var(--sans)}" +
  ".wp-pv-in{flex:1;display:flex;align-items:center;gap:8px;min-width:0;max-width:1120px;margin:0 auto;padding:4px 20px}" +
  ".wp-pv-in>svg.ic,.wp-pv-lead{color:var(--public)}" +
  ".wp-pv-m{flex:1;min-width:0}.wp-pv-lead,.wp-pv-1 b{font-weight:650}.wp-pv-1 b{color:var(--ink)}.wp-pv-s{display:none}" +
  ".wp-pv-back{display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 10px 0 6px;border:1px solid var(--public-line);border-radius:8px;background:var(--surface);color:var(--ink);font-weight:500;text-decoration:none;white-space:nowrap}" +
  ".wp-pv-back:hover{background:var(--hover)}" +
  "@media(pointer:coarse){.wp-pv-back{height:auto;min-height:var(--tap)}}" +
  "@media(max-width:760px){.wp-pv-2{display:none}.wp-pv-m{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}" +
  `@media(max-width:${PHONE_MAX}px){.wp-pv{min-height:48px}.wp-pv-in{gap:6px;padding:0 14px}.wp-pv-1{display:none}.wp-pv-s{display:inline}.wp-pv-back>svg.ic{display:none}}` +
  "@media print{.wp-pv{display:none}}";

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

type StateWord = "uploading" | "stalled" | "waiting" | "failed";

/**
 * A revision row's sync word, from the health snapshot (FC2): a committed revision has no queue
 * row and is still uploading; a pending one reads its precomputed state.
 */
function stateOf(
  ctx: CollectionContext,
  row: RevisionRow,
): { word: StateWord; parent: number | undefined } {
  if (row.sync_state === "failed") return { word: "failed", parent: undefined };
  if (row.sync_state !== "pending") return { word: "uploading", parent: undefined };
  const item = collectionHealth(ctx.chrome.health, ctx.collection.public_id)?.items.find(
    (entry) => entry.id === row.id,
  );
  const word = item?.sync ?? "uploading";
  return {
    word,
    parent:
      word === "waiting" && item?.parent_revision_id
        ? ctx.byId.get(item.parent_revision_id)?.display_number
        : undefined,
  };
}

/** "failed · {cause}", the cause cut to 80 characters. */
function cause(error: string | null | undefined): string {
  const text = error?.trim();
  if (!text) return "no error detail";
  return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
}

function PreviewFacts(props: {
  rows: { label: string; tone: "ok" | "bad" | "pend" | "wait"; icon: string; value: string }[];
}) {
  return (
    <ul class="pv-facts">
      {props.rows.map((row) => (
        <li class={row.tone}>
          <b>{row.label}</b>
          {raw(row.icon)}
          <span>{row.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** The owner's preview of what Latest links show: the collection's latest URL as the public. */
function latestPreviewHref(ctx: CollectionContext): string {
  return `${shellPath(ctx.collection.public_id, ctx.publicSees?.public_id ?? "", "", false, ctx.publicSees?.head_path)}?as=public`;
}

/**
 * The owner's explanation in place of a preview: the public sees only synced revisions, and a
 * link to an unsynced one shows the reader's "This link isn't available" page. Three states: a
 * failed revision (with Retry, and what a Retry can change), one still uploading, waiting or
 * stalled, and a collection with nothing synced.
 */
function notPublicYet(
  c: Context,
  ctx: CollectionContext,
  served: RevisionRow | undefined,
): Promise<Response> {
  const page = (body: unknown) =>
    noStore(
      c.html(
        <Layout
          title={`Not public yet · ${ctx.collection.title}`}
          chrome={ctx.chrome}
          bar={<HomeBarLite chrome={ctx.chrome} />}
          page="not-public"
        >
          {/* The hero's bold sentence is the page's heading (role="heading" level 1, unstyled). */}
          <main class="wrap narrow" id="main" tabindex={-1}>
            {body}
          </main>
        </Layout>,
      ),
    );
  if (!served) {
    const back = shellPath(
      ctx.collection.public_id,
      ctx.revision.public_id,
      "",
      ctx.pinned,
      ctx.revision.head_path,
    );
    return page(
      <>
        <div class="hero warn" data-preview="not-public">
          {raw(icon("clock"))}
          <div>
            <b role="heading" aria-level={1}>
              Nothing is public yet.
            </b>
            <span>
              {`The public sees a revision only once it has synced to the cloud, and no revision of “${ctx.collection.title}” has yet. Its public links show “This link isn't available” until one does.`}
            </span>
          </div>
        </div>
        <div class="btns">
          <a class="btn primary" href={back}>
            Back to the collection
          </a>
          <a class="btn" href="/status">
            Open Status
          </a>
        </div>
      </>,
    );
  }
  const n = served.display_number ?? 0;
  const sees = ctx.publicSees;
  const seen = sees?.display_number ?? 0;
  const back = shellPath(ctx.collection.public_id, served.public_id, "", true, served.head_path);
  const preview = sees ? (
    <a class={served.sync_state === "failed" ? "btn" : "btn primary"} href={latestPreviewHref(ctx)}>
      {raw(icon("globe"))}
      {`Preview #${seen}, what the public sees`}
    </a>
  ) : null;
  if (served.sync_state === "failed") {
    const latest = ctx.latest;
    const onLine = ctx.lineage.onLine.has(served.id);
    const fork = onLine ? null : ctx.lineage.branchPoint(served.id);
    const facts: Parameters<typeof PreviewFacts>[0]["rows"] = [
      sees
        ? {
            label: "Latest links show",
            tone: "ok",
            icon: icon("okcircle"),
            value: `#${seen} · synced`,
          }
        : { label: "Latest links show", tone: "wait", icon: icon("dot"), value: "nothing yet" },
      {
        label: fork ? `#${n} · Branch off #${fork.display_number}` : `#${n}`,
        tone: "bad",
        icon: icon("alert"),
        value: `failed · ${cause(served.last_error)}`,
      },
    ];
    if (latest && latest.id !== served.id && latest.id !== sees?.id) {
      const state = stateOf(ctx, latest);
      facts.push({
        label: `#${latest.display_number ?? 0} · latest`,
        tone: state.word === "failed" ? "bad" : state.word === "waiting" ? "wait" : "pend",
        icon: icon(state.word === "failed" ? "alert" : "clock"),
        value:
          state.word === "waiting" && state.parent !== undefined
            ? `waiting for #${state.parent}`
            : state.word,
      });
    }
    // A Retry can make this branch what Latest links show, until a newer revision uploads.
    const disclose =
      !onLine &&
      latest !== undefined &&
      latest.sync_state !== "synced" &&
      latest.sync_state !== "failed" &&
      (latest.display_number ?? 0) > n &&
      (sees === undefined || n > seen);
    return page(
      <>
        <div class="hero bad" data-preview="failed">
          {raw(icon("alert"))}
          <div>
            <b
              role="heading"
              aria-level={1}
            >{`#${n} failed to upload, so no public link can show it.`}</b>
            <span>
              {`The public reader only has revisions that reached the cloud. An “Only #${n}” link would show “This link isn't available” until #${n} uploads; Retry may fix it.`}
            </span>
          </div>
        </div>
        <PreviewFacts rows={facts} />
        <div class="btns">
          <button
            type="button"
            class="btn primary"
            data-action="retry"
            data-ids={served.id}
            data-n={n}
          >
            {`Retry #${n}`}
          </button>
          {preview}
          <a class="btn ghost" href={back}>
            {`Back to #${n}`}
          </a>
        </div>
        {disclose ? (
          <p class="muted small" data-preview-disclosure="">
            {`Latest links show the newest revision that has synced, whatever its line: if #${n} finishes uploading before #${latest.display_number ?? 0}, they show #${n}${fork ? `, a branch off #${fork.display_number}` : ""}, until #${latest.display_number ?? 0} has uploaded too.`}
          </p>
        ) : null}
      </>,
    );
  }
  const state = stateOf(ctx, served);
  const stalled = state.word === "stalled";
  const only = `An “Only #${n}” link shows “This link isn't available” until #${n} syncs`;
  const body =
    state.word === "waiting" && state.parent !== undefined
      ? `It's waiting for #${state.parent} to upload first. ${only}.`
      : stalled
        ? `Its upload has stalled. ${only}; Status has the details.`
        : `It's still uploading. ${only}.`;
  const until =
    ctx.latest?.id === served.id && sees
      ? ` Until then, Latest links show #${seen} with a note that a newer version is being synced.`
      : "";
  return page(
    <>
      <div class="hero warn" data-preview={stalled ? "stalled" : "uploading"}>
        {raw(icon("clock"))}
        <div>
          <b role="heading" aria-level={1}>{`#${n} isn't public yet.`}</b>
          <span>{`${body}${until}`}</span>
        </div>
      </div>
      <div class="btns">
        {preview}
        <a class="btn" href={back}>
          {`Back to #${n}`}
        </a>
        {stalled ? (
          <a class="btn ghost" href="/status">
            Open Status
          </a>
        ) : null}
      </div>
    </>,
  );
}
