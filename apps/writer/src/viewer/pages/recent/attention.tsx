/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";

import {
  STUCK_AFTER_MS,
  type CollectionHealth,
  type Health,
  type HealthItem,
} from "../../../health.ts";
import { LineStrip, Time } from "../../components.tsx";
import { plural } from "../../format.ts";
import { causeLine, chipText, itemWord, stripModel, type ItemWord } from "../../health-words.ts";
import { attentionHref } from "../status.tsx";

/** Cards on Home; the rest are on Status. */
const CARDS = 3;
/** Row chips per collection; the rest are "+N". */
const ROW_CHIPS = 2;

/** Writer-wide rows: sync blocked, or the cloud out of reach. */
function writerRows(health: Health, now: number): Child[] {
  const rows: Child[] = [];
  if (health.state === "blocked")
    rows.push(
      <div class="ar">
        <span class="t">Sync is blocked</span>
        <span class="acts">
          <a class="btn sm" href="/status">
            Open Status
          </a>
        </span>
        <span class="s mono">{health.blockedReason}</span>
      </div>,
    );
  else if (
    health.syncEnabled &&
    health.cloudError &&
    (health.cloudLastOkAt === null || now - health.cloudLastOkAt > STUCK_AFTER_MS)
  )
    rows.push(
      <div class="ar">
        <span class="t">Can't reach the cloud</span>
        <span class="acts">
          <a class="btn sm" href="/status">
            Open Status
          </a>
        </span>
        <span class="s">
          Writes still work and are queued here.{" "}
          {health.cloudLastOkAt !== null ? (
            <>
              Last success <Time at={health.cloudLastOkAt} fmt="ago" now={now} />.
            </>
          ) : null}
        </span>
      </div>,
    );
  return rows;
}

/** A words line with every revision number in bold. */
function boldRevisions(text: string): Child {
  return <>{text.split(/(#\d+)/).map((part, index) => (index % 2 ? <b>{part}</b> : part))}</>;
}

/** One collection that needs you: its lines, why, and Retry for what failed. */
function AttentionCard(props: { group: CollectionHealth; health: Health; now: number }) {
  const { group, health, now } = props;
  const pub = group.collection_public_id;
  const title = group.collection_title ?? "Untitled";
  const model = stripModel(group);
  const failed = group.items.filter((item) => item.sync === "failed");
  const one = failed.length === 1 ? failed[0] : undefined;
  return (
    <div class="ag" data-attn-collection={pub ?? undefined}>
      <div class="t">
        <a href={pub ? `/c/${pub}/` : "/status"}>{title}</a>{" "}
        {group.project ? <span class="proj">{group.project}</span> : null}
      </div>
      <span class="acts">
        {failed.length ? (
          <button
            type="button"
            class="btn sm"
            data-action="retry"
            data-ids={failed.map((item) => item.id).join(",")}
            data-n={one?.display_number ?? undefined}
            data-title={title}
          >
            {one ? `Retry #${one.display_number ?? "?"}` : `Retry ${failed.length} failed`}
          </button>
        ) : null}
        <a class="btn sm ghost" href={pub ? attentionHref(health, pub) : "/status"}>
          Details
        </a>
      </span>
      <LineStrip model={model} />
      <p class="cause">{boldRevisions(causeLine(group, model, now))}</p>
    </div>
  );
}

/**
 * Home's Needs attention (OW-06b): writer-wide rows, then one card per collection with a failed or
 * stalled revision. With sync off, a neutral note instead, and only when something is queued (the
 * exact complement of NAV-06's "Nothing is backed up" line on an empty local-only writer).
 */
export function NeedsAttention(props: { health: Health; now: number }) {
  const { health, now } = props;
  if (!health.syncEnabled)
    return health.failed.length || health.pending.length ? (
      <p class="attn off" role="note">
        {raw(icon("dot"))}
        <b>Sync is off on this writer.</b> Nothing is backed up or reaches other machines or public
        links. Revisions stay here. <a href="/status">Status</a>
      </p>
    ) : null;
  const rows = writerRows(health, now);
  const groups = health.collections.filter((group) => group.attention);
  if (!rows.length && !groups.length) return null;
  return (
    <section class="attn" aria-labelledby="attn">
      <h2 id="attn">
        Needs attention
        {groups.length ? (
          <>
            {" "}
            <span class="n">{plural(groups.length, "collection")}</span>
          </>
        ) : null}
      </h2>
      {rows}
      {groups.slice(0, CARDS).map((group) => (
        <AttentionCard group={group} health={health} now={now} />
      ))}
      {groups.length > CARDS ? (
        <div class="more">
          <a href="/status">+{groups.length - CARDS} more on Status</a>
        </div>
      ) : null}
    </section>
  );
}

const CHIP_ORDER: Record<ItemWord, number> = { failed: 0, stalled: 1, uploading: 2, waiting: 3 };
function RowChip(props: { item: HealthItem }) {
  const word = itemWord(props.item);
  const n = props.item.display_number;
  if (word === "failed")
    return (
      <span class="chip xs failed">
        {raw(icon("alert", "sm"))}
        {chipText(n, word)}
      </span>
    );
  return (
    <span class={`chip xs ${word === "waiting" ? "waiting" : "pending"}`}>
      {raw(icon("clock", "sm"))}
      {chipText(n, word)}
    </span>
  );
}

/** A Recent or search row's sync chips: its queued revisions by number ("#6 failed"). */
export function RowSyncChips(props: {
  collectionId: string;
  health?: Health | undefined;
}): JSX.Element | null {
  const { health } = props;
  if (!health?.syncEnabled) return null;
  const items = (
    health.collections.find((group) => group.collection_id === props.collectionId)?.items ?? []
  ).toSorted((a, b) => CHIP_ORDER[itemWord(a)] - CHIP_ORDER[itemWord(b)]);
  if (!items.length) return null;
  return (
    <>
      {items.slice(0, ROW_CHIPS).map((item) => (
        <RowChip item={item} />
      ))}
      {items.length > ROW_CHIPS ? <span class="chip xs">+{items.length - ROW_CHIPS}</span> : null}
    </>
  );
}
