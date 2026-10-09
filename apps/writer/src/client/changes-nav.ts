import { plural } from "../viewer/format.ts";
import { matchKey } from "../viewer/keymap.ts";
import { $, $$, storage } from "./dom.ts";
import { bindPageEscape, OPEN_LAYER, typing } from "./page-escape.ts";

/** The change `step` last focused: a click on Previous or Next moves focus to the button, or (in
 *  Safari, and Firefox on macOS, which don't focus a clicked button) to the body, so that is
 *  "current" then. */
let last = -1;

/** Focuses the next (1) or previous (-1) visible change: after the focused one, or the first
 *  below the page top; then says where it is in the stepper's output. */
export function step(direction: 1 | -1): void {
  move(direction, false);
}

/** `step`, told whether a stepper button asked: then the remembered change is "current" even
 *  when the click left focus on the body rather than the button. */
function move(direction: 1 | -1, fromStepper: boolean): void {
  const page = $(".cmp");
  if (!page) return;
  const changes = $$("[data-change]").filter((node) => node.offsetParent !== null);
  if (!changes.length) return;
  const top = page.getBoundingClientRect().top + 8;
  const index = changes.findIndex((node) => node.getBoundingClientRect().top > top + 1);
  const active = document.activeElement;
  let current = active instanceof HTMLElement ? changes.indexOf(active) : -1;
  if (
    current < 0 &&
    (fromStepper || (active instanceof HTMLElement && active.matches("[data-step]")))
  )
    current = last < changes.length ? last : -1;
  const next =
    current >= 0
      ? Math.min(changes.length - 1, Math.max(0, current + direction))
      : direction === 1
        ? Math.max(0, index)
        : Math.max(0, (index < 0 ? changes.length : index) - 1);
  const target = changes[next];
  if (!target) return;
  last = next;
  // focusVisible: Chromium doesn't ring a programmatic focus that follows a mouse click.
  target.focus({ preventScroll: true, focusVisible: true });
  target.scrollIntoView({ block: "center" });
  const output = $("[data-step-count]");
  if (!output) return;
  // "Change 2 of 3" (the word hides on phones), then the file and what changed, for screen readers.
  const word = document.createElement("span");
  word.className = "stepword";
  word.textContent = "Change ";
  const where = [
    target.closest<HTMLElement>("section.fd[data-file-diff]")?.dataset.fileDiff,
    target.dataset.change,
  ].filter(Boolean);
  const said = document.createElement("span");
  said.className = "vh";
  said.textContent = `, ${where.join(", ")}`;
  output.replaceChildren(word, `${next + 1} of ${changes.length}`, ...(where.length ? [said] : []));
}

/** Changes page (its own small bundle): j/k and the stepper's buttons move between changes, Esc
 *  returns to the document (page-escape.ts). */
export function bindChangesNav(): void {
  const page = $(".cmp");
  if (!page) return;
  const done = page.dataset.done;
  if (done) bindPageEscape(done, "changes");
  const stepper = $("[data-stepper]");
  const output = $("[data-step-count]");
  const count = $$("[data-change]").filter((node) => node.offsetParent !== null).length;
  if (stepper && count) {
    // Set before it shows, so it isn't announced.
    if (output) output.textContent = plural(count, "change");
    stepper.hidden = false;
    for (const button of $$("[data-step]", stepper))
      button.addEventListener("click", () => move(Number(button.dataset.step) < 0 ? -1 : 1, true));
  }
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typing(event.target) || document.querySelector(OPEN_LAYER)) return;
    // Esc ("changes-done") is bindPageEscape's.
    const command = matchKey(event, "changes")?.command;
    if (command !== "next-change" && command !== "prev-change") return;
    if (storage()?.getItem("wp:keys") === "off") return;
    event.preventDefault();
    step(command === "next-change" ? 1 : -1);
  });
}
