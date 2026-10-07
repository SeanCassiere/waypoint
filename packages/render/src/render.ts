import { createHighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import bash from "@shikijs/langs/bash";
import cssGrammar from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import sql from "@shikijs/langs/sql";
import toml from "@shikijs/langs/toml";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import type { Element, Root, RootContent } from "hast";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

export const RENDERER_NAME = "markdown";
// Bump this version for any dependency, CSS, language set, template, or option change.
export const RENDERER_VERSION = 1;

const languages = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "bash",
  "python",
  "go",
  "rust",
  "sql",
  "yaml",
  "toml",
  "html",
  "css",
  "diff",
  "markdown",
  "dockerfile",
] as const;
const aliases = new Map<string, (typeof languages)[number]>([
  ["ts", "typescript"],
  ["js", "javascript"],
  ["py", "python"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["yml", "yaml"],
  ["md", "markdown"],
  ["docker", "dockerfile"],
  ["htm", "html"],
]);
function isSupportedLanguage(value: string): value is (typeof languages)[number] {
  return languages.some((language) => language === value);
}

let highlighter: ReturnType<typeof createHighlighterCore> | undefined;
function getHighlighter(): ReturnType<typeof createHighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [
      typescript,
      javascript,
      tsx,
      jsx,
      json,
      bash,
      python,
      go,
      rust,
      sql,
      yaml,
      toml,
      html,
      cssGrammar,
      diff,
      markdown,
      dockerfile,
    ].flat(),
    engine: createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")),
  }).catch((error: unknown) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}

export const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSlug)
  .use(rehypeStringify, { allowDangerousHtml: true });

const css = `:root{color-scheme:light dark;--fg:#24292f;--muted:#57606a;--bg:#fff;--border:#d0d7de;--subtle:#f6f8fa;--link:#0969da;--quote:#d0d7de}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#8b949e;--bg:#0d1117;--border:#30363d;--subtle:#161b22;--link:#58a6ff;--quote:#3d444d}}
*{box-sizing:border-box}html{background:var(--bg);color:var(--fg)}body{max-width:860px;margin:0 auto;padding:32px 28px 64px;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;overflow-wrap:break-word}a{color:var(--link)}h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.5em 0 .6em}h1,h2{padding-bottom:.3em;border-bottom:1px solid var(--border)}h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.25em}p,ul,ol,table,blockquote,pre{margin:0 0 1em}ul,ol{padding-left:2em}li+li{margin-top:.25em}li>p{margin:0}li.task-list-item{list-style:none}li.task-list-item>input{margin:0 .45em 0 -1.4em;vertical-align:middle}blockquote{margin-left:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--quote)}blockquote>:last-child{margin-bottom:0}table{border-collapse:collapse;display:block;max-width:100%;overflow:auto}th,td{padding:6px 13px;border:1px solid var(--border)}tr:nth-child(even){background:var(--subtle)}pre{padding:16px;overflow:auto;background:var(--subtle);border-radius:6px;line-height:1.45}code{font:85%/1.45 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}pre code{font-size:100%}p code,li code,td code{padding:.15em .3em;background:var(--subtle);border-radius:4px}img{max-width:100%;height:auto}hr{border:0;border-top:1px solid var(--border)}.shiki{background:var(--subtle)!important}.shiki span{color:var(--shiki-light)}@media(prefers-color-scheme:dark){.shiki span{color:var(--shiki-dark)}}.footnotes{font-size:.9em;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.front-matter{margin:0 0 1em}`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function nodeText(node: RootContent | Root): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map(nodeText).join("");
  return "";
}

function firstHeading(root: Root): string | undefined {
  for (const node of root.children) {
    if (node.type === "element" && node.tagName === "h1") return nodeText(node);
  }
  return undefined;
}

async function highlight(root: Root): Promise<void> {
  const pending: Array<{
    parent: Root | Element;
    index: number;
    source: string;
    language: (typeof languages)[number];
  }> = [];
  function visit(parent: Root | Element): void {
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index];
      if (node?.type !== "element") continue;
      if (node.tagName === "pre") {
        const code = node.children[0];
        if (code?.type === "element" && code.tagName === "code") {
          const classes = code.properties.className;
          const languageClass = Array.isArray(classes)
            ? classes.find((name) => typeof name === "string" && name.startsWith("language-"))
            : undefined;
          const label =
            typeof languageClass === "string" ? languageClass.slice(9).toLowerCase() : "";
          const source = nodeText(code);
          if (label === "mermaid") {
            // A future /assets/<renderer version>/ script hook can activate Mermaid.
            node.properties.className = ["mermaid"];
            node.children = [{ type: "text", value: source }];
            continue;
          }
          const language = aliases.get(label) ?? label;
          if (isSupportedLanguage(language) && Buffer.byteLength(source, "utf8") <= 100_000) {
            pending.push({ parent, index, source, language });
            continue;
          }
        }
      }
      visit(node);
    }
  }
  visit(root);
  if (pending.length === 0) return;
  const instance = await getHighlighter();
  for (const { parent, index, source, language } of pending) {
    const highlighted = instance.codeToHast(source.endsWith("\n") ? source.slice(0, -1) : source, {
      lang: language,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      tokenizeTimeLimit: 0,
      tokenizeMaxLineLength: 5000,
    });
    const replacement = highlighted.children[0];
    if (replacement?.type === "element") parent.children[index] = replacement;
  }
}

function titleText(title: string | undefined): string {
  return title?.replace(/\s+/gu, " ").trim() || "Untitled";
}

function document(body: string, title: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>${css}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

export type FallbackReason =
  | "file too large to render"
  | "nesting too deep to render"
  | "could not be rendered";
export function fallbackDocument(
  source: string,
  title: string | undefined,
  reason: FallbackReason,
): string {
  return document(
    `<p>Shown as plain text: ${reason}</p>\n<pre class="source-fallback">${escapeHtml(source)}</pre>`,
    titleText(title),
  );
}

function tooDeep(source: string): boolean {
  const threshold = 100;
  const tags: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  for (const line of source.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? "";
      const length = fenceMatch[1]?.length ?? 0;
      if (!fence) fence = { marker, length };
      else if (fence.marker === marker && length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    let quoteDepth = 0;
    let position = 0;
    while (position < line.length) {
      while (line[position] === " ") position++;
      if (line[position] !== ">") break;
      quoteDepth++;
      if (quoteDepth > threshold) return true;
      position++;
    }
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
    if (indent / 2 > threshold) return true;
    const markerRun = /^[*+-]+/u.exec(line.trimStart())?.[0].length ?? 0;
    if (markerRun > threshold) return true;
    for (const match of line.matchAll(/<\/?([A-Za-z][\w:-]*)(?:\s[^<>]*?)?\s*\/?>/gu)) {
      const tag = match[1]?.toLowerCase() ?? "";
      if (voidTags.has(tag)) continue;
      if (match[0].startsWith("</")) {
        const index = tags.lastIndexOf(tag);
        if (index >= 0) tags.length = index;
      } else if (!match[0].endsWith("/>")) {
        tags.push(tag);
        if (tags.length > threshold) return true;
      }
    }
  }
  return false;
}

export async function renderMarkdown(
  source: string,
  options?: { title?: string },
): Promise<string> {
  const fallbackTitle = options?.title;
  if (Buffer.byteLength(source, "utf8") > 1_000_000)
    return fallbackDocument(source, fallbackTitle, "file too large to render");
  if (tooDeep(source)) return fallbackDocument(source, fallbackTitle, "nesting too deep to render");
  try {
    const parsed = processor.parse(source);
    const frontMatter = parsed.children[0]?.type === "yaml" ? parsed.children.shift() : undefined;
    const tree = await processor.run(parsed);
    // Micromark consumes a leading BOM. Keep one that remains after decoding.
    if (source.startsWith("\uFEFF")) tree.children.unshift({ type: "text", value: "\uFEFF" });
    if (frontMatter?.type === "yaml") {
      tree.children.unshift({
        type: "element",
        tagName: "details",
        properties: { className: ["front-matter"] },
        children: [
          {
            type: "element",
            tagName: "summary",
            properties: {},
            children: [{ type: "text", value: "Front matter" }],
          },
          {
            type: "element",
            tagName: "pre",
            properties: {},
            children: [{ type: "text", value: frontMatter.value }],
          },
        ],
      });
    }
    const title = titleText(options?.title ?? firstHeading(tree));
    await highlight(tree);
    return document(processor.stringify(tree), title);
  } catch {
    return fallbackDocument(source, fallbackTitle, "could not be rendered");
  }
}
