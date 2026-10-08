// Real-Chromium checks for the public reader shell, run from source: pnpm test:browser:reader.
// Runs every scenario in tests/browser/reader/ (the numbered baseline, then one file per item),
// or only the named ones: node --conditions=@waypoint/source reader-browser.ts [stem ...]
import { runSuite } from "./browser/harness.ts";

await runSuite("reader", process.argv.slice(2));
