/** @jsxImportSource hono/jsx */
import type { Context } from "hono";

import type { HttpServices } from "../../http.js";
import { getStatus } from "../../status-data.js";
import { badge, fmtDate } from "../components.js";
import { ago } from "../format.js";
import { Layout } from "../layout.js";
import { noStore } from "../respond.js";

export async function statusPage(s: HttpServices, c: Context): Promise<Response> {
  const status = await getStatus(s);
  const syncState = !status.sync_enabled
    ? "off"
    : status.account_paused
      ? "paused"
      : status.sync_blocked
        ? "blocked"
        : status.sync_verified
          ? "verified"
          : "unverified";
  return noStore(
    c.html(
      <Layout title="Status">
        <main class="wrap">
          <h1>Status</h1>
          <p>
            {badge(syncState)}{" "}
            <span class="muted">
              Sync {syncState} · {status.environment}
            </span>
          </p>
          {status.account_paused ? (
            <p class="error">Bucket account paused: {status.account_error}</p>
          ) : null}
          <div class="stats">
            {Object.entries(status.queue).map(([name, value]) => (
              <div class="stat">
                <strong>{value}</strong>
                {name.replaceAll("_", " ")}
              </div>
            ))}
          </div>
          <p>
            Oldest pending:{" "}
            {status.oldest_pending_age_ms === null
              ? "None"
              : ago(Date.now() - status.oldest_pending_age_ms)}
          </p>
          <p>
            Last upload: {fmtDate(status.last_upload_at)} · Last push:{" "}
            {fmtDate(status.last_push_at)} · Last pull: {fmtDate(status.last_pull_at)}
          </p>
          <p>Last error: {status.last_error ?? "None"}</p>
          <h2>Queue errors</h2>
          <div class="list">
            {status.queue_errors.length ? (
              status.queue_errors.map((row) => (
                <div class="row fail">
                  <strong>{row.kind}</strong>
                  <span class="row-title">{row.id}</span>
                  <span class="error">{row.last_error}</span>
                </div>
              ))
            ) : (
              <div class="row muted">No queue errors.</div>
            )}
          </div>
          <h2>Pending revisions</h2>
          <div class="list">
            {status.pending_items.length ? (
              status.pending_items.map((row) => (
                <div class="row">
                  <span class="row-title">
                    {row.collection_public_id ? (
                      <a href={`/c/${row.collection_public_id}/`}>{row.id}</a>
                    ) : (
                      row.id
                    )}
                  </span>
                  <button
                    class="danger"
                    data-action="drop"
                    data-id={row.id}
                    aria-label={`Drop ${row.id}`}
                  >
                    Drop
                  </button>
                </div>
              ))
            ) : (
              <div class="row muted">No pending revisions.</div>
            )}
          </div>
          <h2>Failed revisions</h2>
          <p class="error" data-error role="alert"></p>
          <div class="list">
            {status.failed_items.length ? (
              status.failed_items.map((row) => (
                <div class="row fail">
                  <div class="row-title">
                    <strong>
                      {row.collection_public_id ? (
                        <a href={`/c/${row.collection_public_id}/`}>{row.id}</a>
                      ) : (
                        row.id
                      )}
                    </strong>
                    <br />
                    <small>
                      {fmtDate(row.created_at)} · {row.error_kind ?? "Unknown kind"}
                    </small>
                    <br />
                    {row.last_error ?? "No error detail"}
                  </div>
                  <button data-action="retry" data-id={row.id} aria-label={`Retry ${row.id}`}>
                    Retry
                  </button>
                  <button
                    class="danger"
                    data-action="drop"
                    data-id={row.id}
                    aria-label={`Drop ${row.id}`}
                  >
                    Drop
                  </button>
                </div>
              ))
            ) : (
              <div class="row muted">No failed revisions.</div>
            )}
          </div>
        </main>
      </Layout>,
    ),
  );
}
