// The Collection details dialog's PATCH body (NAV-11), built from its fields. Pure: no DOM and no
// Node APIs, so the client bundle and the tests share it. Tags are split here, in the browser,
// because saving needs script anyway; the PATCH API is unchanged.

/** Splits on commas, trims, drops empties and case-insensitive repeats (the first spelling wins),
 *  keeping the order. */
export function splitTags(text: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of text.split(",")) {
    const tag = part.trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export interface DetailsFields {
  title: string;
  project: string;
  tags: string;
  /** The Other metadata (JSON) textarea. */
  extra: string;
  /** Read-only keys carried through unchanged (source_host). */
  keep: Record<string, unknown>;
}
export type DetailsPatch =
  | { ok: true; body: { title: string; metadata: Record<string, unknown> } }
  | { ok: false; field: "title" | "extra"; message: string };

/** The fields own project and tags: they replace any the extra JSON names. Unknown keys survive. */
export function buildDetailsPatch(fields: DetailsFields): DetailsPatch {
  const title = fields.title.trim();
  if (!title) return { ok: false, field: "title", message: "Enter a title" };
  let parsed: unknown = {};
  // Blank means {}. Otherwise parse the text as typed (JSON allows the surrounding whitespace), so
  // the engine's line and column match what the textarea shows.
  if (fields.extra.trim()) {
    try {
      parsed = JSON.parse(fields.extra);
    } catch (cause) {
      // The engine's own message, unchanged (V8 adds the line and column).
      return {
        ok: false,
        field: "extra",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, field: "extra", message: "Other metadata must be a JSON object" };
  // fromEntries defines keys (a "__proto__" key stays a plain key), where assignment would not.
  const metadata: Record<string, unknown> = Object.fromEntries([
    ...Object.entries(parsed).filter(([key]) => key !== "project" && key !== "tags"),
    ...Object.entries(fields.keep),
  ]);
  const project = fields.project.trim();
  if (project) metadata.project = project;
  const tags = splitTags(fields.tags);
  if (tags.length) metadata.tags = tags;
  return { ok: true, body: { title, metadata } };
}
