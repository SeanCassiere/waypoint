// The Markdown renderer's worker thread, a bundle entry of its own (dist/render-worker.js):
// @waypoint/render, bundled into the writer, starts it from the bundle directory.
// oxlint-disable-next-line import/no-unassigned-import -- The worker module runs on import.
import "@waypoint/render/render-worker";
