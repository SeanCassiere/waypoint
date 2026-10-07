import { $, $$ } from "./dom.js";

/** Gallery: image dimensions in captions and the compare lightbox (spec §5.6). */
export function bindGallery(): void {
  const grid = $("[data-gallery]");
  const dialog = $("#lightbox", HTMLDialogElement);
  if (!grid || !dialog) return;
  for (const image of $$(".shot img", HTMLImageElement, grid)) {
    const fill = () => {
      const dim = image.closest(".shot")?.querySelector("[data-dim]");
      if (dim && image.naturalWidth)
        dim.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
    };
    if (image.complete) fill();
    else image.addEventListener("load", fill, { once: true });
  }
  const shots = $$("[data-shot]", HTMLAnchorElement, grid);
  const before = $("[data-lbx-before] img", HTMLImageElement, dialog);
  const after = $("[data-lbx-after]", HTMLImageElement, dialog);
  const under = $("[data-lbx-under]", HTMLImageElement, dialog);
  const over = $("[data-lbx-over]", HTMLImageElement, dialog);
  const open = $("[data-lbx-open]", HTMLAnchorElement, dialog);
  let index = 0;
  const show = (next: number) => {
    index = (next + shots.length) % shots.length;
    const shot = shots[index];
    if (!shot) return;
    const name = shot.dataset.name ?? "";
    const was = shot.dataset.before ?? "";
    const now = shot.dataset.after ?? "";
    dialog.classList.toggle("single", !was);
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
    }),
  );
  $("[data-lbx-prev]", dialog)?.addEventListener("click", () => show(index - 1));
  $("[data-lbx-next]", dialog)?.addEventListener("click", () => show(index + 1));
  dialog.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") return;
    if (event.key === "ArrowLeft") show(index - 1);
    else if (event.key === "ArrowRight") show(index + 1);
  });
  $("[data-lbx-range]", HTMLInputElement, dialog)?.addEventListener("input", (event) => {
    const range = event.currentTarget;
    if (range instanceof HTMLInputElement) dialog.style.setProperty("--cut", `${range.value}%`);
  });
}
