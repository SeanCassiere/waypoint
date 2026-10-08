/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

import { STUCK_AFTER_MS, type Health } from "../../../health.ts";
import { revisionHref, Time } from "../../components.tsx";

function attentionRows(health: Health, now: number): Child[] {
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
  for (const item of health.failed)
    rows.push(
      <div class="ar">
        <span class="t">
          <a href={revisionHref(item)}>{item.collection_title ?? "Untitled"}</a>{" "}
          <span class="mono">#{item.display_number ?? "?"}</span> failed to sync
        </span>
        <span class="acts">
          <button type="button" class="btn sm" data-action="retry" data-ids={item.id}>
            Retry
          </button>
          <button type="button" class="btn sm danger" data-action="drop" data-id={item.id}>
            Drop…
          </button>
        </span>
        <span class="s">
          {item.last_error ?? "No error detail"}
          {item.source_host ? (
            <>
              {" · written by "}
              <span class="mono">{item.source_host}</span>
            </>
          ) : null}{" "}
          <Time at={item.created_at} now={now} /> · readable here only
        </span>
      </div>,
    );
  if (health.syncEnabled)
    for (const item of health.pending.filter((row) => now - row.created_at > STUCK_AFTER_MS))
      rows.push(
        <div class="ar">
          <span class="t">
            <a href={revisionHref(item)}>{item.collection_title ?? "Untitled"}</a>{" "}
            <span class="mono">#{item.display_number ?? "?"}</span> is stuck uploading
          </span>
          <span class="acts">
            <a class="btn sm" href="/status">
              Open Status
            </a>
          </span>
          <span class="s">
            Started <Time at={item.created_at} fmt="ago" now={now} />
            {item.source_host ? (
              <>
                {" · "}
                <span class="mono">{item.source_host}</span>
              </>
            ) : null}
          </span>
        </div>,
      );
  return rows;
}

export function NeedsAttention(props: { health: Health; now: number }) {
  const rows = attentionRows(props.health, props.now);
  if (!rows.length) return null;
  return (
    <section class="attn" aria-labelledby="attn">
      <h2 id="attn">Needs attention</h2>
      {rows.slice(0, 3)}
      {rows.length > 3 ? (
        <div class="more">
          <a href="/status">+{rows.length - 3} more on Status</a>
        </div>
      ) : null}
    </section>
  );
}
