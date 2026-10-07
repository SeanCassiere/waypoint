import { $, $$ } from "./dom.js";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs a DOM update inside a same-document view transition when supported and wanted. The
 * update runs asynchronously inside a transition, so callers that move focus to something the
 * update reveals must wait for the returned promise (it settles once the update has run).
 */
export function withTransition(update: () => void): Promise<void> {
  if (reduced() || typeof document.startViewTransition !== "function") {
    update();
    return Promise.resolve();
  }
  return document.startViewTransition(update).updateCallbackDone;
}

/**
 * Cross-document polish: the revision timeline entry you click morphs into the next page's
 * revision pill, and "Show N unchanged blocks" folds open with a crossfade.
 */
export function bindMotion(): void {
  let clicked: HTMLElement | null = null;
  document.addEventListener(
    "click",
    (event) => {
      clicked = event.target instanceof Element ? event.target.closest(".rv") : null;
    },
    true,
  );
  window.addEventListener("pageswap", (event) => {
    const transition: unknown = Reflect.get(event, "viewTransition");
    if (!transition || !clicked) return;
    const pill = $(".revbtn");
    if (pill) pill.style.viewTransitionName = "none";
    clicked.style.viewTransitionName = "rev-pill";
  });
  window.addEventListener("pageshow", () => {
    for (const node of $$(".rv, .revbtn")) node.style.viewTransitionName = "";
  });
  for (const summary of $$("details.folded > summary")) {
    summary.addEventListener("click", (event) => {
      const details = summary.parentElement;
      if (!(details instanceof HTMLDetailsElement) || reduced()) return;
      event.preventDefault();
      // The summary stays in place, so focus needs no help here.
      void withTransition(() => {
        details.open = !details.open;
      });
    });
  }
}
