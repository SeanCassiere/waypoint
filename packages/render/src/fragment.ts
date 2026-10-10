// Renders one Markdown block for the Changes page (spec §5.5). Same remark/GFM pipeline as
// renditions, but without Shiki or raw HTML, and sanitized for the writer's own origin:
// no ids or names (DOM clobbering), only http(s)/mailto links, and images as text.
import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/** Private-use sentinels placed in source text around inserted and deleted words. */
export const SENTINELS = {
  insOpen: "",
  insClose: "",
  delOpen: "",
  delClose: "",
} as const;
const SENTINEL_PATTERN = /[-]/g;

const fragmentProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // No allowDangerousHtml: raw HTML in the source is dropped.
  .use(remarkRehype)
  .use(rehypeStringify);

const strip = (value: string) => value.replace(SENTINEL_PATTERN, "");

function cleanProperties(properties: Properties): void {
  delete properties.id;
  delete properties.name;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") properties[key] = strip(value);
    else if (Array.isArray(value))
      properties[key] = value.map((item) => (typeof item === "string" ? strip(item) : item));
  }
}

type State = "ins" | "del" | null;
function splitText(value: string, state: { current: State }): ElementContent[] {
  const out: ElementContent[] = [];
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    const text: ElementContent = { type: "text", value: buffer };
    out.push(
      state.current
        ? { type: "element", tagName: state.current, properties: {}, children: [text] }
        : text,
    );
    buffer = "";
  };
  for (const char of value) {
    if (char === SENTINELS.insOpen || char === SENTINELS.delOpen) {
      flush();
      state.current = char === SENTINELS.insOpen ? "ins" : "del";
    } else if (char === SENTINELS.insClose || char === SENTINELS.delClose) {
      flush();
      state.current = null;
    } else buffer += char;
  }
  flush();
  return out;
}

function transform(parent: Root | Element, state: { current: State }): void {
  const children: (RootContent | ElementContent)[] = [];
  for (const child of parent.children) {
    if (child.type === "text") {
      children.push(...splitText(child.value, state));
      continue;
    }
    if (child.type !== "element") {
      if (child.type !== "raw" && child.type !== "comment") children.push(child);
      continue;
    }
    cleanProperties(child.properties);
    if (child.tagName === "input" && child.properties.type === "checkbox")
      // Task-list boxes are read-only state; name them so they aren't unlabelled form controls.
      child.properties.ariaLabel = child.properties.checked ? "Done" : "Not done";
    if (child.tagName === "img") {
      const alt = typeof child.properties.alt === "string" ? child.properties.alt : "";
      children.push({ type: "text", value: `[image${alt ? `: ${alt}` : ""}]` });
      continue;
    }
    if (child.tagName === "a") {
      const href = typeof child.properties.href === "string" ? child.properties.href : "";
      if (/^(?:https?:|mailto:)/i.test(href)) {
        child.properties.target = "_blank";
        child.properties.rel = ["noopener", "noreferrer"];
      } else {
        // Relative links would resolve against the Changes page, so they render as text.
        child.tagName = "span";
        child.properties = { className: ["rel-link"] };
      }
    }
    transform(child, state);
    children.push(child);
  }
  // Root accepts RootContent and elements accept ElementContent; both sets were preserved above.
  parent.children = children.filter((child): child is ElementContent => child.type !== "doctype");
}

/** Markdown → sanitized HTML; sentinels become balanced <ins>/<del> inside text runs. */
export function renderFragment(markdown: string): string {
  const tree = fragmentProcessor.runSync(fragmentProcessor.parse(markdown));
  transform(tree, { current: null });
  return fragmentProcessor.stringify(tree);
}

/** Builds sentinel-marked source from a word diff. */
export function markWords(
  words: readonly { op: "equal" | "insert" | "delete"; text: string }[],
): string {
  return words
    .map((word) =>
      word.op === "insert"
        ? `${SENTINELS.insOpen}${word.text}${SENTINELS.insClose}`
        : word.op === "delete"
          ? `${SENTINELS.delOpen}${word.text}${SENTINELS.delClose}`
          : word.text,
    )
    .join("");
}

/**
 * Fragments longer than this aren't rendered. Markdown parsing is superlinear on some inputs
 * (nested brackets and emphasis), so this keeps one fragment's cost to a few hundred ms.
 */
export const MAX_FRAGMENT_SOURCE: number = 8 * 1024;

/**
 * Renders a batch of fragments within a time budget. A fragment that is too long, or comes
 * after the budget is spent, is `null`; the caller shows its source instead.
 */
export function renderFragments(sources: readonly string[], budgetMs = 1000): (string | null)[] {
  const deadline = Date.now() + budgetMs;
  return sources.map((source) =>
    source.length > MAX_FRAGMENT_SOURCE || Date.now() > deadline ? null : renderFragment(source),
  );
}
