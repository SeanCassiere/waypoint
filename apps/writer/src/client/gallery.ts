import { matchKey } from "../viewer/keymap.ts";
import { fillDims } from "./dims.ts";
import { $, $$ } from "./dom.ts";
import { bindPageEscape } from "./page-escape.ts";

/** Gallery: image dimensions in captions, Esc to Done and the compare lightbox (spec §5.6). */
export function bindGallery(): void {
  const grid = $("[data-gallery]");
  const dialog = $("#lightbox", HTMLDialogElement);
  if (!grid || !dialog) return;
  fillDims(grid);
  if (grid.dataset.done) bindPageEscape(grid.dataset.done, "gallery");
  const shots = $$("[data-shot]", HTMLAnchorElement, grid);
  const before = $("[data-lbx-before] img", HTMLImageElement, dialog);
  const after = $("[data-lbx-after]", HTMLImageElement, dialog);
  const under = $("[data-lbx-under]", HTMLImageElement, dialog);
  const over = $("[data-lbx-over]", HTMLImageElement, dialog);
  const open = $("[data-lbx-open]", HTMLAnchorElement, dialog);
  const modes = $$("[data-lbx-modes] button[data-mode]", HTMLButtonElement, dialog);
  for (const mode of modes)
    mode.addEventListener("click", () => {
      for (const other of modes) other.setAttribute("aria-pressed", String(other === mode));
      dialog.dataset.mode = mode.dataset.mode ?? "side";
    });
  const prev = $("[data-lbx-prev]", HTMLButtonElement, dialog);
  const next = $("[data-lbx-next]", HTMLButtonElement, dialog);
  const done = $("[data-lbx-done]", HTMLButtonElement, dialog);
  // Where focus starts: the pressed mode, or (with no "before" image, so no modes) Next or Done.
  const start = () =>
    modes.find(
      (mode) => mode.getAttribute("aria-pressed") === "true" && mode.offsetParent !== null,
    ) ?? (shots.length > 1 ? next : done);
  let index = 0;
  const show = (position: number) => {
    index = (position + shots.length) % shots.length;
    const shot = shots[index];
    if (!shot) return;
    const name = shot.dataset.name ?? "";
    const was = shot.dataset.before ?? "";
    const now = shot.dataset.after ?? "";
    dialog.classList.toggle("single", !was);
    // Paging to an image without a "before" hides the modes: keep focus in the dialog.
    if (!was && modes.some((mode) => mode === document.activeElement)) start()?.focus();
    if (before) {
      before.src = was || now;
      before.alt = `${name}, before`;
    }
    if (after) {
      after.src = now;
      after.alt = `${name}, after`;
    }
    if (under) under.src = was || now;
    if (over) over.src = now;
    const title = $("[data-lbx-title]", dialog);
    if (title) title.textContent = name;
    const status = $("[data-lbx-status]", dialog);
    if (status) status.textContent = shot.dataset.status ?? "";
    const count = $("[data-lbx-count]", dialog);
    if (count) count.textContent = `${index + 1} of ${shots.length}`;
    if (open) open.href = shot.href;
  };
  shots.forEach((shot, position) =>
    shot.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      show(position);
      dialog.showModal();
      // The ring shows after a click too, so the starting point is visible. showModal() may have
      // focused it already, without the ring, so focus it afresh.
      const first = start();
      if (first && document.activeElement === first) first.blur();
      first?.focus({ focusVisible: true });
    }),
  );
  // Closing returns focus to the thumbnail of the image on screen, not the one first opened.
  dialog.addEventListener("close", () => shots[index]?.focus());
  prev?.addEventListener("click", () => show(index - 1));
  next?.addEventListener("click", () => show(index + 1));
  // Arrows page images (with single-key shortcuts off too), except in the slider's range input
  // and other fields, which keep their own arrows.
  dialog.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest("input, select, textarea")) return;
    const command = matchKey(event, "gallery")?.command;
    if (command === "image-prev") show(index - 1);
    else if (command === "image-next") show(index + 1);
    else return;
    event.preventDefault();
  });
  $("[data-lbx-range]", HTMLInputElement, dialog)?.addEventListener("input", (event) => {
    const range = event.currentTarget;
    if (range instanceof HTMLInputElement) dialog.style.setProperty("--cut", `${range.value}%`);
  });
}
