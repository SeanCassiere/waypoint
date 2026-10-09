// Renders one Markdown block for the Changes page (spec §5.5). Same remark/GFM pipeline as
// renditions, but without Shiki or raw HTML, and sanitized for the writer's own origin:
// no ids or names (DOM clobbering), http(s)/mailto links in a new tab, relative links only where
// a resolver maps them into the revision, and images as text. GFM alerts render as callouts.
// Fragments are rendered per request and never stored, so they don't affect RENDERER_VERSION.
import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { alertVisit } from "./render.ts";

/** Private-use sentinels placed in source text around inserted and deleted words. */
export const SENTINELS = {
  insOpen: "",
  insClose: "",
  delOpen: "",
  delClose: "",
} as const;

const fragmentProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // No allowDangerousHtml: raw HTML in the source is dropped.
  .use(remarkRehype)
  .use(rehypeStringify);

// A link destination is percent-encoded before it gets here, sentinels included (U+E002 is
// %EE%80%82), so attributes are matched in both forms.
const DELETED_SPAN = /(?:\uE002|%EE%80%82)[\s\S]*?(?:\uE003|%EE%80%83)/gi;
const ANY_SENTINEL = /[\uE000-\uE003]|%EE%80%8[0-3]/gi;
/** An attribute's head side: deleted spans dropped, inserted text kept, every sentinel removed
 * (so a changed link points where the head's link does). The author's own encoding is kept. */
const headSide = (value: string) => value.replace(DELETED_SPAN, "").replace(ANY_SENTINEL, "");

function cleanProperties(properties: Properties): void {
  delete properties.id;
  delete properties.name;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") properties[key] = headSide(value);
    else if (Array.isArray(value))
      properties[key] = value.map((item) => (typeof item === "string" ? headSide(item) : item));
  }
}

/** Where a fragment's relative links point: the head revision's writer path and the file's
 * directory in it. */
export interface FragmentLinks {
  /** `/c/<collection pub>/r/<revision pub>/`, URL-safe, starting and ending with `/`. */
  readonly root: string;
  /** The file's directory inside the revision, URL-encoded: `""` or `"docs/"`. */
  readonly dir: string;
}
/** Maps a relative link's href to a same-origin path, or `null` to show it as text. */
export type FragmentLinkResolver = (href: string) => string | null;

// oxlint-disable-next-line eslint/no-control-regex -- Controls in a link make it text.
const CONTROL = /[\u0000-\u001f\u007f]/;
/**
 * Resolves relative links against a file in a revision. Anything with a scheme, protocol-relative
 * and fragment-only links, backslashes, control characters, encoded separators and paths that
 * climb above the revision (dot segments count encoded too, as browsers read them) stay text
 * (`null`). The author's percent-encoding is kept as written.
 */
export function relativeLinkResolver(links: FragmentLinks): FragmentLinkResolver {
  const dir = links.dir.split("/").filter(Boolean);
  return (href) => {
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(href) ||
      href.includes("\\") ||
      CONTROL.test(href)
    )
      return null;
    const hashAt = href.indexOf("#");
    const hash = hashAt >= 0 ? href.slice(hashAt) : "";
    const path = (hashAt >= 0 ? href.slice(0, hashAt) : href).replace(/\?[^?]*$/, "");
    if (path.includes("?")) return null;
    if (!path) return `${links.root}${hash}`;
    const segments = path.split("/");
    // An encoded / or \ could smuggle a separator or `..` past the checks below.
    if (segments.some((segment) => /%(?:2f|5c)/i.test(segment))) return null;
    const out = path.startsWith("/") ? [] : [...dir];
    const parts = path.startsWith("/") ? segments.slice(1) : segments;
    for (const [index, segment] of parts.entries()) {
      const last = index === parts.length - 1;
      // Browsers read `%2e` as a dot in a dot segment (`%2e%2e`, `.%2E` are `..`), so these are
      // normalised here too, or they would climb past the check once the link is followed.
      const dots = segment.replace(/%2e/gi, ".");
      if (dots === "." || dots === "..") {
        if (dots === "..") {
          if (!out.length) return null;
          out.pop();
        }
        // `dir/.` and `dir/..` name a directory.
        if (last) out.push("");
        continue;
      }
      out.push(segment);
    }
    return `${links.root}${out.join("/")}${hash}`;
  };
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

function transform(
  parent: Root | Element,
  state: { current: State },
  resolveLink?: FragmentLinkResolver,
): void {
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
      // Inside a word mark, the text takes it like any other text.
      children.push(...splitText(`[image${alt ? `: ${alt}` : ""}]`, state));
      continue;
    }
    if (child.tagName === "a") {
      const href = typeof child.properties.href === "string" ? child.properties.href : "";
      if (/^(?:https?:|mailto:)/i.test(href)) {
        child.properties.target = "_blank";
        child.properties.rel = ["noopener", "noreferrer"];
      } else {
        // Relative links would resolve against the Changes page: they point into the revision
        // when the caller resolves them, and render as text otherwise.
        const resolved = resolveLink?.(href) ?? null;
        if (resolved === null) {
          child.tagName = "span";
          child.properties = { className: ["rel-link"] };
        } else child.properties = { href: resolved };
      }
    }
    transform(child, state, resolveLink);
    children.push(child);
  }
  // Root accepts RootContent and elements accept ElementContent; both sets were preserved above.
  parent.children = children.filter((child): child is ElementContent => child.type !== "doctype");
}

/** Markdown → sanitized HTML; sentinels become balanced <ins>/<del> inside text runs. */
export function renderFragment(markdown: string, resolveLink?: FragmentLinkResolver): string {
  const tree = fragmentProcessor.runSync(fragmentProcessor.parse(markdown));
  // Before transform, which splits the sentinel text the alert marker is matched in.
  alertVisit(tree);
  transform(tree, { current: null }, resolveLink);
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
export function renderFragments(
  sources: readonly string[],
  budgetMs = 1000,
  resolveLink?: FragmentLinkResolver,
): (string | null)[] {
  const deadline = Date.now() + budgetMs;
  return sources.map((source) =>
    source.length > MAX_FRAGMENT_SOURCE || Date.now() > deadline
      ? null
      : renderFragment(source, resolveLink),
  );
}
