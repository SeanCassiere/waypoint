import { rendererFor } from "@waypoint/core";

import { getHighlighter, type ShikiLanguage } from "./render.ts";
import {
  counted,
  escapeView,
  formatBytes,
  formatCount,
  splitLines,
  textView,
  VIEW_MAX_CHARS,
  viewKind,
  withoutBom,
  type ViewKind,
} from "./view.ts";

export const TEXT_RENDERER_NAME = "text";
// Bump this version for any change to the text view's output (template, CSS, kinds, languages,
// highlighting, formatting or limits), and update TEXT_GOLDEN_HASH in tests/golden-text.ts in the
// same change. Renditions are keyed by (source hash, renderer, version); see RENDERER_VERSION.
// v1: header, numbered lines with #L<n> anchors, Shiki highlighting, JSON formatting, markers.
export const TEXT_RENDERER_VERSION = 1;

export const TEXT_LIMITS: {
  readonly maxBytes: 2097152;
  readonly maxLines: 50000;
  readonly highlightBytes: 262144;
  readonly highlightLines: 5000;
  readonly formatJsonMinChars: 200;
} = {
  maxBytes: 2_097_152,
  maxLines: 50_000,
  highlightBytes: 262_144,
  highlightLines: 5_000,
  formatJsonMinChars: 200,
};

const colour = /^#[0-9a-fA-F]{3,8}$/u;

/** Each line's highlighted HTML, or undefined when Shiki's lines don't match the source's. */
async function highlightLines(
  lines: readonly string[],
  language: ShikiLanguage,
): Promise<string[] | undefined> {
  try {
    const instance = await getHighlighter();
    const { tokens } = instance.codeToTokens(lines.join("\n"), {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      tokenizeTimeLimit: 0,
      tokenizeMaxLineLength: 5000,
    });
    if (tokens.length !== lines.length) return undefined;
    const html: string[] = [];
    for (const [index, line] of tokens.entries()) {
      // Tokens must cover the line exactly; anything else is shown uncoloured.
      if (line.map((token) => token.content).join("") !== lines[index]) return undefined;
      html.push(
        line
          .map((token) => {
            const style = token.htmlStyle;
            const light = typeof style === "object" ? style["--shiki-light"] : undefined;
            const dark = typeof style === "object" ? style["--shiki-dark"] : undefined;
            const content = escapeView(token.content);
            return light !== undefined &&
              dark !== undefined &&
              colour.test(light) &&
              colour.test(dark)
              ? `<span style="--shiki-light:${light};--shiki-dark:${dark}">${content}</span>`
              : content;
          })
          .join(""),
      );
    }
    return html;
  } catch {
    return undefined;
  }
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
function isPunctuation(code: number): boolean {
  // { } [ ] : ,
  return (
    code === 0x7b ||
    code === 0x7d ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x3a ||
    code === 0x2c
  );
}

/** The tokens of valid JSON, verbatim: strings, numbers and literals keep their exact source text. */
function* jsonTokens(source: string): Generator<string> {
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (isSpace(code)) {
      index++;
    } else if (isPunctuation(code)) {
      yield source[index] ?? "";
      index++;
    } else if (code === 0x22) {
      let end = index + 1;
      while (end < source.length && source.charCodeAt(end) !== 0x22)
        end += source.charCodeAt(end) === 0x5c ? 2 : 1;
      yield source.slice(index, end + 1);
      index = end + 1;
    } else {
      let end = index + 1;
      while (end < source.length) {
        const next = source.charCodeAt(end);
        if (isSpace(next) || isPunctuation(next) || next === 0x22) break;
        end++;
      }
      yield source.slice(index, end);
      index = end;
    }
  }
}

/**
 * Valid JSON re-indented by 2 spaces, lexically: values are never re-serialised, so big numbers,
 * escapes and duplicate keys stay byte-identical. Where nothing is lost it equals
 * `JSON.stringify(JSON.parse(source), null, 2)`. Undefined above the line limit, or when the
 * indentation (which grows with nesting depth) would make the text longer than a view may be.
 */
function formatJson(source: string): string[] | undefined {
  const lines: string[] = [];
  const tokens = [...jsonTokens(source)];
  let line = "";
  let depth = 0;
  let size = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (size + line.length > VIEW_MAX_CHARS) return undefined;
    const token = tokens[index] ?? "";
    if (token === "{" || token === "[") {
      const close = token === "{" ? "}" : "]";
      if (tokens[index + 1] === close) {
        line += token + close;
        index++;
        continue;
      }
      lines.push(line + token);
      size += line.length + 1;
      depth++;
      line = "  ".repeat(depth);
    } else if (token === "}" || token === "]") {
      lines.push(line);
      size += line.length;
      depth--;
      line = "  ".repeat(depth) + token;
    } else if (token === ",") {
      lines.push(line + token);
      size += line.length + 1;
      line = "  ".repeat(depth);
    } else if (token === ":") {
      line += ": ";
    } else {
      line += token;
    }
    if (lines.length > TEXT_LIMITS.maxLines) return undefined;
  }
  lines.push(line);
  return lines.length > TEXT_LIMITS.maxLines ? undefined : lines;
}

/** The JSON shown formatted: one line over the threshold that parses. */
function formattedJson(source: string): string[] | undefined {
  const line = source.endsWith("\r\n")
    ? source.slice(0, -2)
    : source.endsWith("\n")
      ? source.slice(0, -1)
      : source;
  if (line.includes("\n") || line.length <= TEXT_LIMITS.formatJsonMinChars) return undefined;
  try {
    JSON.parse(line);
  } catch {
    return undefined;
  }
  return formatJson(line);
}

/** The text view of these lines, highlighted when the kind has a language and they're in bounds. */
async function linesView(
  kind: ViewKind,
  lines: readonly string[],
  byteLength: number,
  extra: { meta?: string; note?: string } = {},
): Promise<string | null> {
  const contents =
    kind.language !== null &&
    lines.length <= TEXT_LIMITS.highlightLines &&
    Buffer.byteLength(lines.join("\n"), "utf8") <= TEXT_LIMITS.highlightBytes
      ? await highlightLines(lines, kind.language)
      : undefined;
  return textView({
    label: kind.label,
    lines,
    byteLength,
    ...(contents ? { contents } : {}),
    ...extra,
  });
}

/**
 * The text view of a text file (code, logs, JSON, …): `source` is the decoded file and
 * `byteLength` its size in bytes. Null: over the bounds or not a text type (no rendition).
 */
export async function renderText(
  source: string,
  options: { mime: string; byteLength: number },
): Promise<string | null> {
  if (rendererFor(options.mime) !== "text") return null;
  if (options.byteLength > TEXT_LIMITS.maxBytes) return null;
  const text = withoutBom(source);
  const original = splitLines(text);
  if (original.length > TEXT_LIMITS.maxLines) return null;
  const kind = viewKind(options.mime);
  const formatted = kind.label === "JSON" ? formattedJson(text) : undefined;
  // Formatted JSON whose view would be too long is shown as authored, like one over the line limit.
  const view = formatted
    ? await linesView(kind, formatted, options.byteLength, {
        meta: `${counted(formatted.length, "line", "lines")} formatted · 1 line in the original · ${formatBytes(options.byteLength)}`,
        note: `Formatted for reading: the original is one ${formatCount(options.byteLength)}-byte line. Download (above) gives you the file exactly as it was shared.`,
      })
    : null;
  return view ?? (await linesView(kind, original, options.byteLength));
}
