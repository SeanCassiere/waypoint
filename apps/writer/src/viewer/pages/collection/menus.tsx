/** @jsxImportSource hono/jsx */
import { latestCollectionUrl, pinnedRevisionUrl, rawUrl } from "@waypoint/core";
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";

import { rawPath, shellPath } from "../../../viewer-paths.ts";
import { projectAndTags } from "../../format.ts";
import type { CollectionContext } from "./shell.tsx";

const shortUrl = (url: string) => `…${new URL(url).pathname}`;

export function handoffBlock(ctx: CollectionContext): string {
  const { collection, revision, files, latest, s } = ctx;
  const base = s.reads.baseUrl;
  const paths = files.map((file) => file.path);
  const shown = paths.slice(0, 8).join(", ");
  const { project, tags } = projectAndTags(collection.metadataObject);
  const meta = [project ? `project: ${project}` : "", tags.length ? `tags: ${tags.join(", ")}` : ""]
    .filter(Boolean)
    .join(" · ");
  return [
    `Waypoint collection "${collection.title}"`,
    `collection_id: ${collection.id}`,
    `revision: #${revision.display_number ?? "?"} ${revision.id} (${revision.id === latest?.id ? "latest" : "older"}, ${revision.sync_state ?? "synced"})`,
    `head: ${revision.head_path} · files: ${shown}${paths.length > 8 ? `, … +${paths.length - 8} more` : ""}`,
    `url: ${ctx.pinned ? pinnedRevisionUrl(base, collection.public_id, revision.public_id) : latestCollectionUrl(base, collection.public_id)}`,
    `raw head: ${rawUrl(base, revision.public_id, revision.head_path)}`,
    ...(meta ? [meta] : []),
    `Read: get_collection("${collection.id}", include_head: true)`,
    `Watch: wait_for_revision(after_revision_id: "${revision.id}")`,
  ].join("\n");
}

export function CopyMenu(props: { ctx: CollectionContext; path: string }) {
  const { ctx, path } = props;
  const base = ctx.s.reads.baseUrl;
  const latestUrl = latestCollectionUrl(
    base,
    ctx.collection.public_id,
    path === ctx.revision.head_path ? undefined : path,
  );
  const pinnedUrl = pinnedRevisionUrl(base, ctx.collection.public_id, ctx.revision.public_id, path);
  return (
    <div id="copy-menu" class="menu" popover="auto">
      <div class="mbox has-list">
        <div class="mbody">
          {/* A menu holds only menu items (axe aria-required-children), so the menu is the list
              and the pinned footer (owned, as the footer sits outside the scrolling body), and
              the handoff Preview disclosure follows it in the body, with its own native keys. */}
          <div role="menu" aria-label="Copy" aria-owns="copy-menu-foot">
            <div class="lbl">
              <span class="lbl-ic">{raw(icon("lock", "sm"))}Tailnet links</span>
              <span class="lbl-note"> · open only on your tailnet</span>
            </div>
            <button
              type="button"
              class="mi"
              role="menuitem"
              popovertarget="copy-menu"
              popovertargetaction="hide"
              data-action="copy-link"
              data-kind="latest"
            >
              <span>Link to latest</span>
              <kbd>c</kbd>
              <small class="mono" data-copy-preview="latest">
                {shortUrl(latestUrl)}
              </small>
            </button>
            <button
              type="button"
              class="mi"
              role="menuitem"
              popovertarget="copy-menu"
              popovertargetaction="hide"
              data-action="copy-link"
              data-kind="pinned"
            >
              <span>Link to this revision (#{ctx.revision.display_number ?? "?"})</span>
              <kbd>⇧C</kbd>
              <small class="mono" data-copy-preview="pinned">
                {shortUrl(pinnedUrl)}
              </small>
            </button>
            <hr />
            <div class="lbl">For another agent</div>
            <button
              type="button"
              class="mi"
              role="menuitem"
              popovertarget="copy-menu"
              popovertargetaction="hide"
              data-action="copy-handoff"
            >
              <span>Handoff block</span>
              <kbd>a</kbd>
              <small>Paste into an agent prompt. It has everything needed to read and watch.</small>
            </button>
          </div>
          <details class="handoff-d">
            <summary>Preview</summary>
            <pre class="handoff" data-handoff>
              {handoffBlock(ctx)}
            </pre>
          </details>
        </div>
        <div class="mfoot" id="copy-menu-foot">
          <button
            type="button"
            class="mi"
            role="menuitem"
            popovertarget="copy-menu"
            popovertargetaction="hide"
            data-action="copy-text"
            data-text={ctx.collection.id}
            data-label="collection ID"
          >
            <span>Collection ID</span>
            <small class="mono">{ctx.collection.id}</small>
          </button>
          <button
            type="button"
            class="mi"
            role="menuitem"
            popovertarget="copy-menu"
            popovertargetaction="hide"
            data-action="copy-text"
            data-text={ctx.revision.id}
            data-label="revision ID"
          >
            <span>Revision ID</span>
            <small class="mono">{ctx.revision.id}</small>
          </button>
          {/* Copy link's URLs open only on the tailnet; Share makes one for anyone (NAV-09). */}
          {ctx.sharing ? (
            <div class="mnote">
              Need a link for someone outside the tailnet? Use{" "}
              <button
                type="button"
                class="linkbtn"
                role="menuitem"
                commandfor="share"
                command="show-modal"
              >
                Share
              </button>
              .
            </div>
          ) : (
            <div class="mnote">
              Need a link for someone outside the tailnet? Public links need a share key; see
              Status.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MoreMenu(props: { ctx: CollectionContext; path: string; previewPublic?: boolean }) {
  const { ctx, path } = props;
  const rawHref = rawPath(ctx.revision.public_id, path);
  // The current file by name (frame-sync keeps it in step on in-frame navigation).
  const name = path.split("/").at(-1) ?? path;
  return (
    <div id="more-menu" class="menu" popover="auto" role="menu" aria-label="More actions">
      <div class="mbox">
        {ctx.sharing ? (
          <button
            type="button"
            class="mi pubitem show-sm"
            role="menuitem"
            commandfor="share"
            command="show-modal"
          >
            <span>Share…</span>
            <kbd>s</kbd>
          </button>
        ) : null}
        {/* 761–1099.98 px: Copy link leaves the bar, so its actions are here (NAV-04). */}
        <div class="lbl midonly">Copy link</div>
        <button
          type="button"
          class="mi midonly"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="copy-link"
          data-kind="latest"
        >
          <span>Link to latest</span>
          <kbd>c</kbd>
        </button>
        <button
          type="button"
          class="mi midonly"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="copy-link"
          data-kind="pinned"
        >
          <span>Link to this revision (#{ctx.revision.display_number ?? "?"})</span>
          <kbd>⇧C</kbd>
        </button>
        <button
          type="button"
          class="mi midonly"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="copy-handoff"
        >
          <span>Handoff block</span>
          <kbd>a</kbd>
        </button>
        <hr class="midonly" />
        <button
          type="button"
          class="mi"
          role="menuitem"
          commandfor="details"
          command="show-modal"
          data-focus="title"
        >
          <span>Rename…</span>
        </button>
        <button
          type="button"
          class="mi"
          role="menuitem"
          commandfor="details"
          command="show-modal"
          data-focus="project"
        >
          <span>Edit details…</span>
        </button>
        <hr />
        <a
          class="mi"
          role="menuitem"
          href={rawHref}
          target="_blank"
          rel="noopener"
          title={path}
          data-open-raw
        >
          <span>
            Open <span data-file-name>{name}</span> raw
          </span>
        </a>
        <a
          class="mi"
          role="menuitem"
          href={`${rawHref}?download`}
          download
          title={path}
          data-download-raw
        >
          <span>
            Download <span data-file-name>{name}</span>
          </span>
        </a>
        <button
          type="button"
          class="mi"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="print"
        >
          <span>Print</span>
        </button>
        {props.previewPublic ? (
          <a
            class="mi"
            role="menuitem"
            href={`${shellPath(ctx.collection.public_id, ctx.revision.public_id, path, ctx.pinned, ctx.revision.head_path)}?as=public`}
            target="_blank"
            rel="noopener"
          >
            <span>Preview as public</span>
          </a>
        ) : null}
        <button type="button" class="mi" role="menuitem" commandfor="keys" command="show-modal">
          <span>Keyboard shortcuts</span>
          <kbd>?</kbd>
        </button>
        <hr />
        <button
          type="button"
          class="mi dangeritem"
          role="menuitem"
          popovertarget="more-menu"
          popovertargetaction="hide"
          data-action="trash"
        >
          <span>Move to Trash…</span>
        </button>
      </div>
    </div>
  );
}
