import { parentPort } from "node:worker_threads";

import { renderMarkdown } from "./render.ts";

if (!parentPort) throw new Error("Renderer worker requires a parent port");
const port = parentPort;
port.on("message", (message: { id: number; source: string; title?: string }) => {
  void (async () => {
    const html = await renderMarkdown(
      message.source,
      message.title === undefined ? undefined : { title: message.title },
    );
    port.postMessage({ id: message.id, html });
  })();
});
