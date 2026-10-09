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
import { readingTokensCss } from "@waypoint/ui";
import type { Element, Root, RootContent } from "hast";
import type { Root as MdastRoot } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified, type Processor } from "unified";

export const RENDERER_NAME = "markdown";
// Bump this version for any dependency, CSS, language set, template, or option change, and
// update the golden hash in tests/golden.ts in the same change. Renditions are keyed by
// (source hash, renderer, version) and readers serve the highest version, so an unbumped change
// would leave two different outputs claiming the same key. Existing blobs get the new version
// through `waypoint-writer rerender`.
// v1: GitHub-like template. v2: Folio reading template (headings anchors, alerts, contents,
// table wrap, figures, code labels, frame reporter, dir="auto" on text blocks). v3: Folio tokens
// (readingTokensCss from @waypoint/ui): warm rules, Contents box and code wells, links in the
// public blue, and the chrome's 2px ink focus ring.
export const RENDERER_VERSION = 3;

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

const alertTitles = new Map([
  ["note", "Note"],
  ["tip", "Tip"],
  ["important", "Important"],
  ["warning", "Warning"],
  ["caution", "Caution"],
]);

function isBlank(node: RootContent | undefined): boolean {
  return node?.type === "text" && node.value.trim() === "";
}

function element(
  tagName: string,
  properties: Element["properties"],
  children: Element["children"],
): Element {
  return { type: "element", tagName, properties, children };
}

/**
 * GitHub alerts: a Markdown blockquote whose first line is exactly `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]` (any case) and that has content after it.
 * Runs before rehype-raw, so blockquotes written as raw HTML are left alone.
 */
export function alertVisit(parent: Root | Element): void {
  for (let index = 0; index < parent.children.length; index++) {
    const node = parent.children[index];
    if (node?.type !== "element") continue;
    alertVisit(node);
    if (node.tagName !== "blockquote") continue;
    const firstIndex = node.children.findIndex((child) => !isBlank(child));
    const first = node.children[firstIndex];
    if (first?.type !== "element" || first.tagName !== "p") continue;
    const lead = first.children[0];
    if (lead?.type !== "text") continue;
    const match = /^\[!([A-Za-z]+)\][ \t]*(?:\n|$)/u.exec(lead.value);
    const kind = match?.[1]?.toLowerCase() ?? "";
    const title = alertTitles.get(kind);
    if (!match || !title) continue;
    // `[!NOTE]` followed by inline content on the same line is not an alert.
    if (!match[0].endsWith("\n") && first.children.length > 1) continue;
    const rest = lead.value.slice(match[0].length);
    const paragraph = rest
      ? [{ ...lead, value: rest }, ...first.children.slice(1)]
      : first.children.slice(1);
    const after = node.children.slice(firstIndex + 1);
    const body: Element["children"] =
      paragraph.length > 0 ? [{ ...first, children: paragraph }, ...after] : after;
    if (!body.some((child) => !isBlank(child))) continue;
    parent.children[index] = element(
      "div",
      { className: ["markdown-alert", `markdown-alert-${kind}`] },
      [
        { type: "text", value: "\n" },
        element("p", { className: ["markdown-alert-title"] }, [{ type: "text", value: title }]),
        ...(paragraph.length > 0 ? [{ type: "text" as const, value: "\n" }] : []),
        ...body,
      ],
    );
  }
}

function rehypeAlerts() {
  return (tree: Root): void => {
    alertVisit(tree);
  };
}

export const processor: Processor<MdastRoot, MdastRoot, Root, Root, string> = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeAlerts)
  .use(rehypeRaw)
  .use(rehypeSlug)
  .use(rehypeStringify, { allowDangerousHtml: true });

// Folio reading template (spec section 8, final/render-final.css). Deviations from that file:
// heading anchors also cover h5/h6; lone images use figure.image instead of p>img:only-child so
// images inside running text stay inline; alerts get the block margin; and on wide screens a
// table wrap grows only as wide as its table needs (at least the measure, at most
// min(100vw - 64px, 1120px)), centred, instead of every table spanning the full breakout.
// The colours come from the frozen `readingTokensCss` in @waypoint/ui (VS-07): changing them
// means a RENDERER_VERSION bump.
const css = `${readingTokensCss}*{box-sizing:border-box}
html{background:var(--bg);color:var(--fg);-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0 auto;max-width:calc(var(--measure) + 64px);padding:40px 32px 96px;font:17px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;font-feature-settings:"kern","liga","calt";overflow-wrap:break-word;hyphens:manual;text-rendering:optimizeLegibility}
::selection{background:var(--mark)}
a{color:var(--link);text-decoration:underline;text-decoration-color:var(--link-u);text-decoration-thickness:1px;text-underline-offset:.18em}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:4px}
pre:focus-visible{border-radius:8px}
h1,h2,h3,h4,h5,h6{line-height:1.25;font-weight:650;letter-spacing:-.011em;margin:2em 0 .6em;scroll-margin-top:16px;position:relative;text-wrap:balance}
h1{font-size:2.05rem;letter-spacing:-.022em;margin-top:0;line-height:1.15}
h2{font-size:1.45rem;padding-top:1.1em;border-top:1px solid var(--line)}
h1+h2{border-top:0;padding-top:0}
h3{font-size:1.18rem}h4{font-size:1rem}h5,h6{font-size:.9rem;color:var(--fg-2)}
.anchor{position:absolute;left:-1.1em;width:1em;color:var(--muted);text-decoration:none;opacity:0;font-weight:400}
h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor,h5:hover .anchor,h6:hover .anchor,.anchor:focus{opacity:1}
p,ul,ol,dl,table,blockquote,pre,figure,details{margin:0 0 1.15em}
p{text-wrap:pretty}
ul,ol{padding-left:1.5em}li{padding-left:.15em}li+li{margin-top:.3em}li>p{margin:0 0 .4em}li::marker{color:var(--muted)}
ol>li::marker{font-variant-numeric:tabular-nums}
li.task-list-item{list-style:none;margin-left:-1.4em}li.task-list-item>input{width:1em;height:1em;margin:0 .55em 0 0;vertical-align:-.12em;accent-color:var(--tip)}
strong{font-weight:650}
blockquote{padding:.1em 0 .1em 1.1em;color:var(--fg-2);border-left:3px solid var(--line-2)}
blockquote>:last-child{margin-bottom:0}
.markdown-alert{margin:0 0 1.15em;border-left:3px solid var(--note);padding:.6em 1em;background:var(--subtle);border-radius:0 6px 6px 0;color:var(--fg)}
.markdown-alert>:last-child{margin-bottom:0}
.markdown-alert-title{font-weight:650;font-size:.88em;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.25em;color:var(--note)}
.markdown-alert-tip{border-color:var(--tip)}.markdown-alert-tip .markdown-alert-title{color:var(--tip)}
.markdown-alert-warning{border-color:var(--warn)}.markdown-alert-warning .markdown-alert-title{color:var(--warn)}
.markdown-alert-caution{border-color:var(--caution)}.markdown-alert-caution .markdown-alert-title{color:var(--caution)}
.table-wrap{margin:0 0 1.4em;overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:linear-gradient(to right,var(--bg) 30%,transparent) left/40px 100% no-repeat local,linear-gradient(to left,var(--bg) 30%,transparent) right/40px 100% no-repeat local,radial-gradient(farthest-side at 0 50%,rgba(0,0,0,.16),transparent) left/12px 100% no-repeat scroll,radial-gradient(farthest-side at 100% 50%,rgba(0,0,0,.16),transparent) right/12px 100% no-repeat scroll}
.table-wrap:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media(min-width:900px){.table-wrap{width:max-content;min-width:100%;max-width:min(100vw - 64px,1120px);position:relative;left:50%;transform:translateX(-50%)}}
table{border-collapse:collapse;width:100%;margin:0;font-size:.9em;line-height:1.5;font-variant-numeric:tabular-nums}
th,td{padding:.55em .85em;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;min-width:9ch}
th{background:var(--subtle);font-weight:600;font-size:.92em;white-space:nowrap}
tr:last-child td{border-bottom:0}
td+td,th+th{border-left:1px solid var(--line)}
code,kbd,samp{font:.86em/1.5 ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono",Menlo,Consolas,"Liberation Mono",monospace}
:not(pre)>code{padding:.12em .36em;background:var(--code-bg);border:1px solid var(--line);border-radius:5px;white-space:nowrap}
pre{position:relative;padding:14px 16px;overflow:auto;background:var(--code-bg)!important;border:1px solid var(--line);border-radius:8px;line-height:1.55;tab-size:2}
pre code{font-size:.84rem;background:none;border:0;padding:0}
pre[data-lang]::before{content:attr(data-lang);position:absolute;top:6px;right:10px;font:600 10.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
@media(min-width:900px){pre{margin-inline:-16px}}
.shiki span{color:var(--shiki-light)}@media(prefers-color-scheme:dark){.shiki span{color:var(--shiki-dark)}}
img,svg,video{max-width:100%;height:auto}
figure.image{margin:1.6em 0}figure.image img{display:block;margin:0 auto;border-radius:8px;border:1px solid var(--line);background:#fff}
hr{border:0;border-top:1px solid var(--line);margin:2.5em 0}
details.toc{font-size:.92em;border:1px solid var(--line);border-radius:8px;padding:.6em 1em;background:var(--subtle)}
details.toc>summary{cursor:pointer;font-weight:600;color:var(--fg-2)}
details.toc ol{margin:.5em 0 .2em;padding-left:1.2em}details.toc li{margin:.15em 0}details.toc a{text-decoration:none}
.footnotes{font-size:.9em;color:var(--fg-2);border-top:1px solid var(--line);margin-top:3em;padding-top:1em}
.front-matter{font-size:.85em;color:var(--muted)}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:600px){:not(pre)>code{white-space:normal;overflow-wrap:anywhere}body{font-size:16.5px;padding:24px 18px 72px}h1{font-size:1.7rem}h2{font-size:1.3rem}.anchor{display:none}}
@media print{body{max-width:none;padding:0;font-size:11pt}a{color:inherit}pre,.table-wrap{break-inside:avoid}details.toc,.anchor{display:none}}`;

/**
 * The frame reporter (spec section 8). It tells the embedding shell which document is showing,
 * because the public reader's sandboxed iframe has an opaque origin the shell cannot read.
 * It posts only `location.pathname + location.hash` to `parent`: no origin, query string,
 * referrer, or document content. The shell already knows that path (it set the frame's src),
 * and the parent must check `event.source` itself. It also collapses the contents block on
 * phones; without JS the block simply stays open. The width is checked after layout (an iframe
 * starts at its default 300px before the shell sizes it) and again whenever it crosses 600px,
 * until the reader toggles the block themselves.
 */
export const FRAME_REPORTER = `(()=>{const d=document,t=d.querySelector("details.toc"),r=f=>d.readyState=="complete"?f():addEventListener("load",f);if(t){const q=matchMedia("(max-width:600px)");let u;const f=()=>{u||d.documentElement.clientWidth&&(t.open=!q.matches)};t.onclick=()=>u=1;q.onchange=f;r(()=>requestAnimationFrame(f))}const p=parent;if(p==window)return;const s=()=>{try{p.postMessage({type:"waypoint:location",href:location.pathname+location.hash},"*")}catch{}};addEventListener("hashchange",s);r(s)})();`;

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
          if (/^[a-z0-9][\w#+.-]{0,23}$/u.test(label) && label !== "mermaid")
            node.properties.dataLang = label;
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
    const original = parent.children[index];
    if (replacement?.type === "element") {
      if (original?.type === "element" && typeof original.properties.dataLang === "string")
        replacement.properties.dataLang = original.properties.dataLang;
      parent.children[index] = replacement;
    }
  }
}

function titleText(title: string | undefined): string {
  return title?.replace(/\s+/gu, " ").trim() || "Untitled";
}

function document(body: string, title: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escapeHtml(title)}</title>\n<style>${css}</style>\n</head>\n<body>\n${body}\n<script>${FRAME_REPORTER}</script>\n</body>\n</html>\n`;
}

const headingTags = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
function hasClass(node: Element, name: string): boolean {
  const classes = node.properties.className;
  return Array.isArray(classes) && classes.includes(name);
}
function plainText(node: Element): string {
  return nodeText(node).replace(/\s+/gu, " ").trim();
}
function walk(parent: Root | Element, fn: (node: Element, parent: Root | Element) => void): void {
  for (const node of parent.children) {
    if (node.type !== "element") continue;
    fn(node, parent);
    walk(node, fn);
  }
}

/** A `<details class="toc">` listing the h2s when there are at least four (spec section 8). */
export const TOC_MIN_H2 = 4;
function contents(root: Root): Element | undefined {
  const entries: Element[] = [];
  walk(root, (node) => {
    if (node.tagName !== "h2" || hasClass(node, "sr-only")) return;
    const id = node.properties.id;
    if (typeof id !== "string" || id === "") return;
    entries.push(
      element("li", { dir: "auto" }, [
        element("a", { href: `#${id}` }, [{ type: "text", value: plainText(node) }]),
      ]),
    );
  });
  if (entries.length < TOC_MIN_H2) return undefined;
  return element("details", { className: ["toc"], open: true }, [
    element("summary", {}, [{ type: "text", value: "Contents" }]),
    element("ol", {}, entries),
  ]);
}

/** Lone images become figures; a paragraph holding only an image (optionally linked). */
function loneImage(node: Element): boolean {
  const children = node.children.filter((child) => !isBlank(child));
  const only = children[0];
  if (children.length !== 1 || only?.type !== "element") return false;
  if (only.tagName === "img") return true;
  if (only.tagName !== "a") return false;
  const inner = only.children.filter((child) => !isBlank(child));
  return inner.length === 1 && inner[0]?.type === "element" && inner[0].tagName === "img";
}

/** Text blocks take their direction from their own text, so RTL documents read right to left. */
const bidiBlocks = new Set([
  ...headingTags,
  "p",
  "li",
  "td",
  "th",
  "blockquote",
  "dt",
  "dd",
  "figcaption",
]);

function decorate(root: Root): void {
  const insideTable = new WeakSet<Element>();
  walk(root, (node, parent) => {
    if (bidiBlocks.has(node.tagName) && node.properties.dir === undefined)
      node.properties.dir = "auto";
    if (node.tagName === "table") {
      walk(node, (inner) => insideTable.add(inner));
      if (insideTable.has(node)) return;
      const index = parent.children.indexOf(node);
      parent.children[index] = element(
        "div",
        { className: ["table-wrap"], tabIndex: 0, role: "region", ariaLabel: "Table" },
        [node],
      );
    } else if (node.tagName === "p" && loneImage(node)) {
      node.tagName = "figure";
      node.properties = { className: ["image"] };
    } else if (headingTags.has(node.tagName) && !hasClass(node, "sr-only")) {
      const id = node.properties.id;
      if (typeof id !== "string" || id === "") return;
      node.children.unshift(
        element("a", { className: ["anchor"], href: `#${id}`, ariaHidden: "true", tabIndex: -1 }, [
          { type: "text", value: "#" },
        ]),
      );
    }
  });
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
    const toc = contents(tree);
    await highlight(tree);
    decorate(tree);
    if (toc) {
      // After the first h1, or else after the leading BOM and front matter.
      const h1 = tree.children.findIndex(
        (node) => node.type === "element" && node.tagName === "h1",
      );
      const lead = (source.startsWith("\uFEFF") ? 1 : 0) + (frontMatter?.type === "yaml" ? 1 : 0);
      tree.children.splice(h1 >= 0 ? h1 + 1 : lead, 0, { type: "text", value: "\n" }, toc);
    }
    return document(processor.stringify(tree), title);
  } catch {
    return fallbackDocument(source, fallbackTitle, "could not be rendered");
  }
}
