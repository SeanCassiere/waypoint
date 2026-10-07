import { markdownRenderer, RENDERER_NAME, RENDERER_VERSION } from "@waypoint/render";

import type { Renderer } from "./ingest.js";
export const writerRenderer: Renderer = {
  rendererName: RENDERER_NAME,
  rendererVersion: RENDERER_VERSION,
  render: (source, mime) => markdownRenderer.render(source, mime),
};
