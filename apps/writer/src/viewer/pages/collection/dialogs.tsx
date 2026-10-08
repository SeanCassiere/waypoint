/** @jsxImportSource hono/jsx */
import type { CollectionContext } from "./shell.tsx";

export function CollectionDialogs(props: { ctx: CollectionContext }) {
  const { ctx } = props;
  return (
    <>
      <dialog class="dlg narrow" id="rename" aria-labelledby="rename-title">
        <form data-form="rename">
          <div class="bd">
            <h2 id="rename-title">Rename collection</h2>
            <label class="fl">
              Title
              <input name="title" value={ctx.collection.title} required maxLength={300} autofocus />
            </label>
          </div>
          <p class="alert" role="alert" data-form-error />
          <div class="ft">
            <button class="btn" formmethod="dialog" formnovalidate value="cancel">
              Cancel
            </button>
            <button class="btn primary">Save</button>
          </div>
        </form>
      </dialog>
      <dialog class="dlg" id="metadata" aria-labelledby="metadata-title">
        <form data-form="metadata">
          <div class="bd">
            <h2 id="metadata-title">Edit metadata</h2>
            <label class="fl">
              Collection metadata (JSON object)
              <textarea name="metadata" spellcheck={false}>
                {JSON.stringify(ctx.collection.metadataObject, null, 2)}
              </textarea>
              <small>
                Used for search and the Projects list. Revision metadata isn't affected.
              </small>
            </label>
          </div>
          <p class="alert" role="alert" data-form-error />
          <div class="ft">
            <button class="btn" formmethod="dialog" formnovalidate value="cancel">
              Cancel
            </button>
            <button class="btn primary">Save</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
