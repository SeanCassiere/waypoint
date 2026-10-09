import { csvRenderer, markdownRenderer, textRenderer, type HtmlRenderer } from "@waypoint/render";

import { rendererSet, type Renderer, type RendererSet } from "./ingest.ts";

function adapt(renderer: HtmlRenderer): Renderer {
  return {
    rendererName: renderer.name,
    rendererVersion: renderer.version,
    render: (source, mime) => renderer.render(source, mime),
  };
}

/** The markdown renderer alone (markdown files only), for existing callers and tests. */
export const writerRenderer: Renderer = adapt(markdownRenderer);
/** Every renderer this writer has: markdown, text and CSV, each picked by the file's MIME type. */
export const writerRenderers: RendererSet = rendererSet([
  writerRenderer,
  adapt(textRenderer),
  adapt(csvRenderer),
]);
