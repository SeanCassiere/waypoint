#!/usr/bin/env node
// Renders the Wrangler config for one reader target of instance.env (deploy/upgrade.sh).
//
//   node reader-config.mjs --template <wrangler.jsonc> --main <built worker .js> --name <worker>
//     --domain <hostname> --dataset <analytics engine dataset> --ratelimit-namespace <id>
//     [--workers-dev true|false]
//
// The committed apps/reader/wrangler.jsonc is the template: it supplies the compatibility date and
// flags, observability and the binding names and limits. The target supplies the Worker name, its
// custom domain, the Analytics Engine dataset and the rate-limit namespace. The output deploys the
// prebuilt Worker as is (`no_bundle`), with Worker Previews off, and `workers.dev` off unless the
// target turns it on. JSON goes to stdout; nothing else does. Plain JavaScript with JSDoc types,
// so it runs on the deploy host with nothing but Node.
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{
 *   name: string, main: string, domain: string, dataset: string,
 *   ratelimitNamespace: string, workersDev: boolean,
 * }} Target
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The single object in a template array, or an error naming the key.
 * @param {Record<string, unknown>} template
 * @param {string} key
 */
function only(template, key) {
  const list = template[key];
  if (!Array.isArray(list) || list.length !== 1 || !isRecord(list[0]))
    throw new Error(`template must have exactly one entry in ${key}`);
  return list[0];
}

/** @param {string} message @returns {never} */
function fail(message) {
  process.stderr.write(`reader-config: ${message}\n`);
  process.exit(1);
}

/**
 * JSONC to a value: drops comments and trailing commas outside strings.
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 1;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else out += c;
  }
  return /** @type {unknown} */ (JSON.parse(out));
}

// Template keys this generator knows how to carry over. Anything else fails, so a new setting in
// wrangler.jsonc can't silently miss production.
const TEMPLATE_KEYS = new Set([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "observability",
  "workers_dev",
  "preview_urls",
  "analytics_engine_datasets",
  "ratelimits",
]);

/** @type {Record<string, RegExp>} */
const PATTERNS = {
  name: /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  domain: /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
  dataset: /^[A-Za-z0-9_]{1,64}$/,
  "ratelimit-namespace": /^[0-9]{1,10}$/,
  "workers-dev": /^(?:true|false)$/,
};

/**
 * @param {Record<string, unknown>} template
 * @param {Target} target
 */
export function renderReaderConfig(template, target) {
  for (const key of Object.keys(template))
    if (!TEMPLATE_KEYS.has(key))
      throw new Error(`template key ${key} isn't handled; update deploy/lib/reader-config.mjs`);
  if (typeof template.compatibility_date !== "string")
    throw new Error("template has no compatibility_date");
  const dataset = only(template, "analytics_engine_datasets");
  const limit = only(template, "ratelimits");
  return {
    name: target.name,
    main: target.main,
    // The Worker was bundled by the reader build (wrangler deploy --dry-run --outdir dist); upload
    // exactly that file.
    no_bundle: true,
    compatibility_date: template.compatibility_date,
    ...(template.compatibility_flags === undefined
      ? {}
      : { compatibility_flags: template.compatibility_flags }),
    observability: template.observability ?? { enabled: false },
    workers_dev: target.workersDev,
    preview_urls: false,
    routes: [{ pattern: target.domain, custom_domain: true }],
    analytics_engine_datasets: [{ ...dataset, dataset: target.dataset }],
    ratelimits: [{ ...limit, namespace_id: target.ratelimitNamespace }],
  };
}

/** @param {string[]} argv */
function main(argv) {
  /** @type {Record<string, string>} */
  const args = { "workers-dev": "false" };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`bad arguments near ${flag ?? "end"}`);
    args[flag.slice(2)] = value;
  }
  for (const key of ["template", "main", "name", "domain", "dataset", "ratelimit-namespace"])
    if (!args[key]) fail(`--${key} is required`);
  for (const [key, pattern] of Object.entries(PATTERNS))
    if (!pattern.test(args[key] ?? "")) fail(`invalid --${key}`);
  const get = (/** @type {string} */ key) => args[key] ?? fail(`--${key} is required`);
  if (!isAbsolute(get("main"))) fail("--main must be an absolute path");
  /** @type {unknown} */
  let template;
  try {
    template = parseJsonc(readFileSync(get("template"), "utf8"));
  } catch (error) {
    fail(
      `can't read ${get("template")}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(template)) fail("the template isn't a JSON object");
  try {
    const config = renderReaderConfig(template, {
      name: get("name"),
      main: get("main"),
      domain: get("domain"),
      dataset: get("dataset"),
      ratelimitNamespace: get("ratelimit-namespace"),
      workersDev: get("workers-dev") === "true",
    });
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
