// Real-Chromium checks for the writer's viewer, against the built writer: pnpm test:browser.
// Runs every scenario in tests/browser/viewer/ (the numbered baseline, then one file per item),
// or only the named ones: node --conditions=@waypoint/source viewer-browser.ts [stem ...]
import { runSuite } from "./browser/harness.ts";

await runSuite("viewer", process.argv.slice(2));
