/** @jsxImportSource hono/jsx */
import { icon } from "@waypoint/ui";
import { raw } from "hono/html";

import { isLive } from "../../../shares.ts";
import { plural, projectAndTags } from "../../format.ts";
import type { CollectionContext } from "./shell.tsx";

/** The collection's `source_host` when it's a non-empty string (shown as Written on). */
export function writtenOn(metadata: Record<string, unknown>): string | null {
  const host = metadata.source_host;
  return typeof host === "string" && host.trim() ? host.trim() : null;
}

/**
 * One Collection details dialog (NAV-11): Title, Project and Tags as fields, Written on read-only,
 * and every other metadata key as JSON. It opens without script (commandfor); saving needs script
 * (client/details.ts), so Save is rendered disabled with a note that the script removes.
 */
export function CollectionDialogs(props: { ctx: CollectionContext }) {
  const { ctx } = props;
  const meta = ctx.collection.metadataObject;
  const { project, tags: stringTags } = projectAndTags(meta);
  const host = writtenOn(meta);
  // The fields own project and tags when the value has the field's shape (a string; a string or a
  // list of strings). Any other value (agents write free-form metadata) can't be shown in a field,
  // so, like the read-only source_host, it's carried through data-keep and survives a save; a
  // non-empty field still replaces it.
  const rawTags = meta.tags;
  const ownsTags =
    typeof rawTags === "string" ||
    (Array.isArray(rawTags) && rawTags.every((tag) => typeof tag === "string"));
  const tags = ownsTags ? stringTags : [];
  // The hint names the first tag that isn't blank (a blank one searches for nothing).
  const searchTag = tags.find((tag) => tag.trim());
  const keep = Object.fromEntries(
    Object.entries(meta).filter(
      ([key]) =>
        key === "source_host" ||
        (key === "project" && project === null) ||
        (key === "tags" && !ownsTags),
    ),
  );
  const rest = Object.fromEntries(
    Object.entries(meta).filter(([key]) => !["project", "tags", "source_host"].includes(key)),
  );
  const live = ctx.links.filter(isLive).length;
  return (
    <dialog class="dlg details" id="details" aria-labelledby="details-title">
      <form data-form="details" data-keep={JSON.stringify(keep)}>
        <div class="bd">
          <h2 id="details-title">Collection details</h2>
          <label class="fl">
            Title
            <input name="title" value={ctx.collection.title} required maxLength={300} autofocus />
          </label>
          {live ? (
            <p class="pubnote">
              {raw(icon("globe", "sm"))} Public links show the title.{" "}
              <b>{plural(live, "live link")}</b> will show the new one.
            </p>
          ) : null}
          <label class="fl">
            Project
            <input
              name="project"
              value={project ?? ""}
              list="details-projects"
              autocapitalize="none"
              autocomplete="off"
              spellcheck={false}
              aria-describedby="details-project-hint"
            />
            <small id="details-project-hint">
              Groups collections on Recent.
              {project?.trim() ? (
                <>
                  {" "}
                  Search with <code>project:{project}</code>.
                </>
              ) : null}
            </small>
          </label>
          <datalist id="details-projects" />
          <label class="fl">
            Tags
            <input
              name="tags"
              value={tags.join(", ")}
              autocapitalize="none"
              autocomplete="off"
              spellcheck={false}
              aria-describedby="details-tags-hint"
            />
            <small id="details-tags-hint">
              Separate with commas.
              {searchTag ? (
                <>
                  {" "}
                  Search with <code>tag:{searchTag}</code>.
                </>
              ) : null}
            </small>
          </label>
          <p class="tagsugg" data-tag-suggest hidden>
            <span>Used on other collections:</span>
          </p>
          {host ? (
            <div class="fl ro">
              <span class="lbl">Written on</span> <span class="mono">{host}</span>
              <small>Set by the agent that created the collection.</small>
            </div>
          ) : null}
          <details class="othermeta">
            <summary>Other metadata (JSON) · {plural(Object.keys(rest).length, "key")}</summary>
            <textarea
              name="extra"
              spellcheck={false}
              aria-label="Other metadata (JSON)"
              aria-describedby="details-json-err"
            >
              {JSON.stringify(rest, null, 2)}
            </textarea>
            <p id="details-json-err" class="jsonerr" data-json-error />
          </details>
        </div>
        <p class="alert" role="alert" data-form-error />
        <div class="ft">
          <span class="grow nojs" data-nojs>
            Saving needs JavaScript, which isn't running on this page.
          </span>
          <button type="button" class="btn" commandfor="details" command="close">
            Cancel
          </button>
          <button type="submit" class="btn primary" disabled data-details-save>
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
