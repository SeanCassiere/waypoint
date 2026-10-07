import { WaypointError } from "./errors.js";

const types = new Map<string, string>(
  Object.entries({
    html: "text/html",
    htm: "text/html",
    md: "text/markdown",
    markdown: "text/markdown",
    txt: "text/plain",
    log: "text/plain",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    cjs: "text/javascript",
    jsx: "text/javascript",
    mts: "text/typescript",
    cts: "text/typescript",
    ts: "text/typescript",
    tsx: "text/typescript",
    py: "text/x-python",
    sh: "text/x-shellscript",
    json: "application/json",
    jsonl: "application/x-ndjson",
    diff: "text/x-diff",
    patch: "text/x-diff",
    toml: "application/toml",
    ini: "text/plain",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    pdf: "application/pdf",
    csv: "text/csv",
    xml: "application/xml",
    yaml: "application/yaml",
    yml: "application/yaml",
    wasm: "application/wasm",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
  }),
);
export function inferMime(path: string): string {
  return (
    types.get(path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "") ??
    "application/octet-stream"
  );
}
const token = "[A-Za-z0-9!#$%&'*+.^_`|~-]+";
const essencePattern = new RegExp(`^${token}/${token}$`);
const parameterPattern = new RegExp(`^\\s*${token}\\s*=\\s*(?:${token}|"[^"\\r\\n]*")\\s*$`);
export function normalizeMime(mime: string): string {
  if (
    typeof mime !== "string" ||
    Array.from(mime).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    throw new WaypointError("validation_failed", "Invalid MIME type");
  const [rawEssence, ...parameters] = mime.split(";");
  const essence = rawEssence?.trim().toLowerCase() ?? "";
  if (
    !essencePattern.test(essence) ||
    parameters.some((parameter) => !parameterPattern.test(parameter))
  )
    throw new WaypointError("validation_failed", "Invalid MIME type");
  return essence;
}
export function isMarkdown(mime: string): boolean {
  return normalizeMime(mime) === "text/markdown";
}
export function isTextMime(mime: string): boolean {
  const essence = normalizeMime(mime);
  const textApplications = new Set([
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/x-javascript",
    "application/typescript",
    "application/toml",
    "application/x-toml",
    "application/ndjson",
    "application/x-ndjson",
  ]);
  return (
    essence.startsWith("text/") ||
    essence === "image/svg+xml" ||
    textApplications.has(essence) ||
    /^application\/[\w.+-]+\+(?:json|xml|yaml)$/.test(essence)
  );
}
