/** @jsxImportSource hono/jsx */
import type { CollectionContext } from "../collection/index.tsx";

/** Shortens an option label at a word boundary, with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The revision menu's Compare… picker: choose any two revisions. */
export function CompareDialog(props: { ctx: CollectionContext; basePub: string | null }) {
  const { ctx } = props;
  const options = ctx.timeline.toReversed();
  return (
    <dialog class="dlg narrow" id="compare" aria-labelledby="compare-title">
      <form data-form="compare" method="get" action={`/c/${ctx.collection.public_id}/`}>
        <div class="bd">
          <h2 id="compare-title">Compare revisions</h2>
          <div class="fields">
            <label class="fl">
              From (older)
              <select name="base">
                {options.map((row) => (
                  <option
                    value={row.public_id}
                    selected={
                      row.public_id ===
                      (props.basePub ??
                        ctx.byId.get(ctx.revision.parent_revision_id ?? "")?.public_id)
                    }
                  >
                    #{row.display_number} · {clip(row.message ?? "No message", 60)}
                  </option>
                ))}
              </select>
            </label>
            <label class="fl">
              To (newer)
              <select name="head">
                {options.map((row) => (
                  <option value={row.public_id} selected={row.id === ctx.revision.id}>
                    #{row.display_number} · {clip(row.message ?? "No message", 60)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <p class="alert" role="alert" data-form-error />
        <div class="ft">
          <button class="btn" formmethod="dialog" formnovalidate value="cancel">
            Cancel
          </button>
          <button class="btn primary">Compare</button>
        </div>
      </form>
    </dialog>
  );
}
