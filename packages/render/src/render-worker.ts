import { parentPort } from "node:worker_threads";

import { renderCsv } from "./csv.ts";
import { renderMarkdown } from "./render.ts";
import { renderText } from "./text.ts";

if (!parentPort) throw new Error("Renderer worker requires a parent port");
const port = parentPort;
// A message without `kind` is markdown. Text and CSV views answer null over their bounds or on an error.
port.on(
  "message",
  (message: {
    id: number;
    source: string;
    title?: string;
    kind?: "markdown" | "text" | "csv";
    mime?: string;
    byteLength?: number;
  }) => {
    void (async () => {
      const view = { mime: message.mime ?? "", byteLength: message.byteLength ?? 0 };
      let html: string | null;
      if (message.kind === "text" || message.kind === "csv") {
        // A text or CSV view that throws answers null (no rendition) rather than ending the
        // worker, which would fail every other job in this slot, markdown included.
        try {
          html =
            message.kind === "text"
              ? await renderText(message.source, view)
              : await renderCsv(message.source, view);
        } catch {
          html = null;
        }
      } else {
        html = await renderMarkdown(
          message.source,
          message.title === undefined ? undefined : { title: message.title },
        );
      }
      port.postMessage({ id: message.id, html });
    })();
  },
);
