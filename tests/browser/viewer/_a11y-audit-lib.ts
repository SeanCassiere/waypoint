// A11Y-AUDIT's shared checks, for tests/browser/viewer/A11Y-AUDIT.ts and
// tests/browser/reader/A11Y-AUDIT.ts: axe with one configuration, accessibility-tree skeletons
// compared with the committed tests/browser/a11y-audit/<kind>/*.aria.yml files (written instead
// when the scenario runs directly with UPDATE_ARIA=1), and the page invariants. Every check is one
// counted assertion; a failure is recorded, not thrown, so one run reports every page's problems,
// and `finish()` fails the scenario with all of them.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright";
import { z } from "zod";

import { assert, axe, VIEWPORTS, type PageOptions } from "../harness.ts";

/** The audit's axe configuration (A3.1): every WCAG 2.x A/AA tag, best practices, and the
 *  experimental label-content-name-mismatch rule (A11Y-04's contract). */
export const AXE_OPTIONS: { tags: string[]; enable: string[] } = {
  tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
  enable: ["label-content-name-mismatch"],
};

export type Width = "desktop" | "tablet" | "phone";
/** The three spot-check widths; phones also get the mobile viewport and user agent. */
export const WIDTHS: readonly { readonly width: Width; readonly options: PageOptions }[] = [
  { width: "desktop", options: VIEWPORTS.desktop },
  { width: "tablet", options: VIEWPORTS.tablet },
  { width: "phone", options: { ...VIEWPORTS.phone, mobile: true } },
];

/** An axe result accepted with a reason (a false positive). Must stay empty; see A3.1. */
export interface AxeException {
  page: string;
  rule: string;
  target: string;
  why: string;
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
const WEEKDAYS =
  "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun";
/** Replaces the volatile parts of accessibility-tree text: the demo seeds every time relative to
 *  now, and IDs, tokens and ports are new on every run. Words are never touched, except the
 *  day words (Today, Yesterday, weekdays) the day groups are named by. */
export function normalizeAria(text: string): string {
  return (
    text
      // Tokens first: their characters may contain anything below.
      .replace(/wps_[A-Za-z0-9_-]+/g, "wps_<t>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      .replace(/\b(?:col|rev|sl|shl)_[0-9a-z]+\b/g, "<id>")
      .replace(/\b(?=[0-9a-z]*\d)[0-9a-z]{12}\b/g, "<pub>")
      .replace(/\b\d{1,2}:\d{2}\b/g, "HH:MM")
      .replace(/\b\d+ (?:s|sec|min|mins|minutes?|h|hours?|days?) ago\b/g, "N ago")
      .replace(/\bin \d+ (?:min|mins|minutes?|hours?|days?)\b/g, "in N")
      // Weekdays before dates, so the date placeholder's "Mon" stays.
      .replace(new RegExp(`\\b(?:${WEEKDAYS}|Today|Yesterday|today|yesterday)\\b`, "g"), "Day")
      .replace(new RegExp(`\\b\\d{1,2} (?:${MONTHS})\\b`, "g"), "D Mon")
  );
}

const KEPT =
  /^\s*- '?(?:banner|navigation|main|region|complementary|contentinfo|search|form|dialog|alertdialog|heading|tablist|tab|list)(?=[\s:"[']|$)/;
const indentOf = (line: string): number => /^\s*/.exec(line)?.[0].length ?? 0;
/** A day group's region (Recent, search): Today, Yesterday and weekdays all read "Day". */
const DAY = /^\s*- region "Day"/;
/** Folds a run of identical day-group blocks (the region line and the kept lines under it) into
 *  one: how many day groups a page shows depends on the time of day the demo was seeded at. Any
 *  other repeated block, and a day group that differs from the one before it, stays. */
function foldDays(lines: readonly string[]): string[] {
  const out: string[] = [];
  let previous: string | null = null;
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (!DAY.test(line)) {
      out.push(line);
      previous = null;
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && indentOf(lines[end] ?? "") > indentOf(line)) end += 1;
    const block = lines.slice(index, end);
    const text = block.join("\n");
    if (text !== previous) out.push(...block);
    previous = text;
    index = end;
  }
  return out;
}
/** A page's outline from Playwright's ariaSnapshot() (A3.2): only the landmark, heading, dialog,
 *  tab and list lines, each kept with its own indentation, normalised (normalizeAria), with a
 *  run of identical day groups folded into one (foldDays). */
export function skeleton(snapshot: string): string {
  const kept = snapshot
    .split("\n")
    .filter((line) => KEPT.test(line))
    .map((line) => normalizeAria(line.trimEnd()));
  return `${foldDays(kept).join("\n")}\n`;
}

const problems = z.array(z.string());
/** Browser-side: the page invariants (A3.3) other than the skip link and dialogs. `bar` is the
 *  writer's global bar, which must be (inside) the banner. */
const INVARIANTS = (bar: string | null) => `(() => {
  const problems = [];
  const shown = (node) => node.checkVisibility() && !node.closest('[aria-hidden="true"]');
  const describe = (node) => node.outerHTML.slice(0, 140);
  const mains = [...document.querySelectorAll('main, [role="main"]')].filter(shown);
  if (mains.length !== 1) problems.push(mains.length + " main landmarks");
  const scoped = 'article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]';
  const banners = [...document.querySelectorAll('header:not([role]), [role="banner"]')]
    .filter((node) => shown(node) && (node.getAttribute("role") === "banner" || !node.parentElement?.closest(scoped)));
  if (banners.length > 1) problems.push(banners.length + " banners");
  const bar = ${bar === null ? "null" : `document.querySelector(${JSON.stringify(bar)})`};
  if (bar && !banners.some((banner) => banner.contains(bar))) problems.push("the bar isn't inside the banner");
  const h1s = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')]
    .filter((node) => shown(node) && !node.closest("dialog"));
  if (h1s.length !== 1) problems.push(h1s.length + " level-1 headings: " + h1s.map((h) => JSON.stringify(h.textContent.trim())).join(", "));
  for (const node of document.querySelectorAll("[tabindex]"))
    if (node.tabIndex > 0 && shown(node)) problems.push("tabindex > 0: " + describe(node));
  for (const img of document.querySelectorAll("img"))
    if (!img.hasAttribute("alt")) problems.push("img without alt: " + describe(img));
  const control = 'a[href], button, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"]';
  const named = (node) => {
    if (node.getAttribute("aria-label")?.trim() || node.getAttribute("aria-labelledby") || node.getAttribute("title")?.trim()) return true;
    const copy = node.cloneNode(true);
    for (const svg of copy.querySelectorAll("svg")) svg.remove();
    return copy.textContent.trim() !== "";
  };
  for (const svg of document.querySelectorAll("svg")) {
    if (svg.parentElement?.closest("svg") || svg.closest('[aria-hidden="true"]')) continue;
    if (svg.getAttribute("role") === "img" && (svg.getAttribute("aria-label")?.trim() || svg.getAttribute("aria-labelledby") || svg.querySelector(":scope > title")?.textContent.trim())) continue;
    const owner = svg.closest(control);
    if (owner && named(owner)) continue;
    // An unrendered sprite sheet (symbols only) isn't in the tree.
    if (!svg.checkVisibility() || (svg.querySelector("symbol") && !svg.querySelector(":scope > :not(symbol, defs)"))) continue;
    problems.push("svg neither hidden nor named: " + describe(svg));
  }
  return problems;
})()`;

/** Browser-side: whether the element is the focused one (`document.activeElement`). */
const focusedIs = (selector: string) =>
  `document.activeElement === document.querySelector(${JSON.stringify(selector)})`;
/** Browser-side: a short description of the focused element. */
const FOCUSED = `(() => { const a = document.activeElement; if (!a || a === document.body) return "body";
  return a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.className && typeof a.className === "string" ? "." + a.className.trim().split(/\\s+/).join(".") : "") + " " + JSON.stringify((a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 40)); })()`;

const ROOT = fileURLToPath(new URL("../a11y-audit/", import.meta.url));
/** Run directly (not through turbo, whose strict env drops it), UPDATE_ARIA=1 writes the files. */
const UPDATE = process.env.UPDATE_ARIA === "1";

/** One scenario's audit: counted checks whose failures are collected until `finish()`. */
export class Audit {
  readonly kind: "viewer" | "reader";
  readonly exceptions: readonly AxeException[];
  readonly bar: string | null;
  private readonly failures: string[] = [];
  private readonly written: string[] = [];
  private checks = 0;

  constructor(kind: "viewer" | "reader", exceptions: readonly AxeException[], bar: string | null) {
    this.kind = kind;
    this.exceptions = exceptions;
    this.bar = bar;
  }

  /** One counted assertion: `found` lists the problems (none passes). */
  check(label: string, found: readonly string[]): void {
    this.checks += 1;
    try {
      assert.deepEqual(found, [], label);
    } catch {
      this.failures.push(`${label}:\n  ${found.join("\n  ")}`);
    }
  }

  /** A condition as a check. */
  expect(label: string, ok: boolean, problem: string): void {
    this.check(label, ok ? [] : [problem]);
  }

  /** axe on the top document, minus the recorded exceptions for this page. */
  async axe(page: Page, label: string, id: string, include?: string): Promise<void> {
    const violations = await axe(
      page,
      include === undefined ? AXE_OPTIONS : { ...AXE_OPTIONS, include },
    );
    const found = violations.flatMap((violation) =>
      violation.nodes
        .filter(
          (node) =>
            !this.exceptions.some(
              (e) => e.page === id && e.rule === violation.id && e.target === node.target.join(" "),
            ),
        )
        .map(
          (node) =>
            `${violation.id} (${violation.impact ?? "?"}): ${violation.help} — ${node.target.join(" ")} ${node.html.slice(0, 160)}`,
        ),
    );
    this.check(`${label}: axe`, found);
  }

  /** axe in light (the page's scheme) and, where `dark`, again in dark. */
  async axeSchemes(page: Page, label: string, id: string, dark: boolean, include?: string) {
    await this.axe(page, `${label} light`, id, include);
    if (!dark) return;
    await scheme(page, "dark");
    await this.axe(page, `${label} dark`, id, include);
    await scheme(page, "light");
  }

  /** The page's skeleton against tests/browser/a11y-audit/<kind>/<name>.aria.yml. */
  async skeleton(page: Page, label: string, name: string): Promise<string> {
    const actual = skeleton(await page.locator("body").ariaSnapshot());
    const file = `${ROOT}${this.kind}/${name}.aria.yml`;
    if (UPDATE) {
      await mkdir(`${ROOT}${this.kind}`, { recursive: true });
      await writeFile(file, actual);
      this.written.push(name);
      this.check(`${label}: skeleton written`, []);
      return actual;
    }
    const expected = await readFile(file, "utf8").catch(() => null);
    if (expected === null) {
      this.check(`${label}: skeleton`, [`no ${name}.aria.yml (run with UPDATE_ARIA=1)`]);
      return actual;
    }
    this.check(
      `${label}: skeleton`,
      expected === actual ? [] : [`differs from ${name}.aria.yml; now:\n${actual}`],
    );
    return actual;
  }

  /** The page invariants (A3.3) that read the DOM. */
  async invariants(page: Page, label: string): Promise<void> {
    this.check(`${label}: invariants`, problems.parse(await page.evaluate(INVARIANTS(this.bar))));
  }

  /** The first Tab from the top focuses a.skip, whose target exists and is focusable or a
   *  landmark. `required`: the page must have one (the writer's pages and the reader's shell). */
  async skipLink(page: Page, label: string, required: boolean): Promise<void> {
    const has = (await page.locator("a.skip").count()) > 0;
    if (!has) {
      this.expect(`${label}: skip link`, !required, "no a.skip");
      return;
    }
    await page.keyboard.press("Tab");
    const found = problems.parse(
      await page.evaluate(`(() => {
        const problems = [];
        const skip = document.querySelector("a.skip");
        if (document.activeElement !== skip) problems.push("the first Tab focuses " + ${FOCUSED});
        const id = (skip.getAttribute("href") || "").replace(/^#/, "");
        const target = id && document.getElementById(id);
        if (!target) problems.push("the skip target #" + id + " doesn't exist");
        else {
          const landmark = target.matches('main, nav, aside, [role="main"], [role="navigation"], [role="region"], [role="complementary"]');
          const focusable = target.hasAttribute("tabindex") || target.matches("a[href], button, iframe, input, select, textarea, summary");
          if (!landmark && !focusable) problems.push("the skip target #" + id + " is neither focusable nor a landmark");
        }
        return problems;
      })()`),
    );
    this.check(`${label}: skip link`, found);
  }

  /** An open modal dialog (A3.3): named, focus inside; Escape closes it and focus returns to
   *  `returnTo`. Call after the other checks: it closes the dialog. */
  async dialog(page: Page, label: string, returnTo: string | null): Promise<void> {
    const dialog = page.locator("dialog[open]");
    const count = await dialog.count();
    this.expect(`${label}: one open dialog`, count === 1, `${count} open dialogs`);
    if (count !== 1) return;
    const first = (await dialog.ariaSnapshot()).split("\n")[0] ?? "";
    this.expect(
      `${label}: dialog named`,
      /^- '?(?:alert)?dialog "[^"]+"/.test(first),
      `dialog line ${first}`,
    );
    this.expect(
      `${label}: focus in the dialog`,
      z
        .boolean()
        .parse(
          await page.evaluate(
            `document.querySelector("dialog[open]").contains(document.activeElement)`,
          ),
        ),
      `focus is on ${String(await page.evaluate(FOCUSED))}`,
    );
    await page.keyboard.press("Escape");
    await page
      .waitForFunction(`!document.querySelector("dialog[open]")`, undefined, {
        timeout: 3000,
      })
      .catch(() => undefined);
    this.expect(
      `${label}: Escape closes the dialog`,
      (await page.locator("dialog[open]").count()) === 0,
      "still open",
    );
    if (returnTo !== null) await this.returned(page, label, returnTo);
  }

  /** An open auto popover (A3.3): `:popover-open`, named on itself, its .mbox or the menu its
   *  .mbox holds (the Copy menu's role sits on its list, so the Preview disclosure after it isn't
   *  a menu child: decision 1, E3); Escape closes it and focus returns to its trigger. Call last:
   *  it closes the popover. */
  async popover(page: Page, label: string, id: string, trigger: string): Promise<void> {
    const state = z.object({ open: z.boolean(), named: z.boolean() }).parse(
      await page.evaluate(`(() => {
          const pop = document.getElementById(${JSON.stringify(id)});
          const box = pop?.querySelector(":scope > .mbox");
          const menu = box?.querySelector("[role=menu]");
          const named = (node) => !!node && !!((node.getAttribute("aria-label") || "").trim() ||
            (node.getAttribute("aria-labelledby") || "").split(/\\s+/).some((ref) => document.getElementById(ref)?.textContent.trim()));
          return { open: !!pop?.matches(":popover-open"), named: named(pop) || named(box) || named(menu) };
        })()`),
    );
    this.expect(`${label}: #${id} is open`, state.open, "not :popover-open");
    this.expect(`${label}: #${id} named`, state.named, "no aria-label or aria-labelledby");
    await page.keyboard.press("Escape");
    await page
      .waitForFunction(
        `!document.getElementById(${JSON.stringify(id)}).matches(":popover-open")`,
        undefined,
        {
          timeout: 3000,
        },
      )
      .catch(() => undefined);
    this.expect(
      `${label}: Escape closes #${id}`,
      z
        .boolean()
        .parse(
          await page.evaluate(
            `!document.getElementById(${JSON.stringify(id)}).matches(":popover-open")`,
          ),
        ),
      "still open",
    );
    await this.returned(page, label, trigger);
  }

  /** Focus lands on `selector` ("body": nothing focused) within a second: some surfaces hand
   *  focus back from their close handler, a task after the close. */
  private async returned(page: Page, label: string, selector: string): Promise<void> {
    const back = await page
      .waitForFunction(
        selector === "body" ? `document.activeElement === document.body` : focusedIs(selector),
        undefined,
        { timeout: 1000 },
      )
      .then(() => true)
      .catch(() => false);
    this.expect(
      `${label}: focus returns to ${selector}`,
      back,
      `focus is on ${String(await page.evaluate(FOCUSED))}`,
    );
  }

  /** Fails the scenario with every recorded problem; logs the files written under UPDATE_ARIA. */
  finish(): void {
    if (this.written.length > 0)
      console.log(
        `A11Y-AUDIT ${this.kind}: wrote ${this.written.length} skeletons (UPDATE_ARIA=1)`,
      );
    console.log(`A11Y-AUDIT ${this.kind}: ${this.checks} checks, ${this.failures.length} failed`);
    if (this.failures.length > 0)
      throw new Error(
        `A11Y-AUDIT ${this.kind}: ${this.failures.length} of ${this.checks} checks failed\n\n${this.failures.join("\n\n")}`,
      );
  }
}

/** Waits for the running CSS transitions (a menu fading out, colours changing scheme) to end, so
 *  axe reads the settled page, not a frame of the fade; at most a second, as a transition
 *  interrupted at the wrong moment may never settle. Looping animations are left running. */
export async function quiet(page: Page): Promise<void> {
  await page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => {
      setTimeout(resolve, 1000);
      Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition)
        .map((a) => a.finished.catch(() => undefined))).then(resolve);
    }))`,
  );
}
async function scheme(page: Page, colorScheme: "light" | "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await quiet(page);
}

/** Waits for the page's own script to have run: loaded, fonts ready, two frames painted. */
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  await page.evaluate(
    `document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))`,
  );
}
