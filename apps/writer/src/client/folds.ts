import { $ } from "./dom.ts";

/**
 * Changes page: folded runs of unchanged blocks aren't on the page. Opening one fetches its
 * rendered blocks from the compare API (`format=html`) once; on failure the fold keeps its
 * link to the no-script view, which shows short runs inline.
 */
export function bindFolds(): void {
  document.addEventListener(
    "toggle",
    (event) => {
      const fold = event.target;
      if (!(fold instanceof HTMLDetailsElement) || !fold.open) return;
      const url = fold.dataset.fold;
      const body = $("[data-fold-body]", fold);
      if (!url || !body || fold.dataset.foldState) return;
      fold.dataset.foldState = "loading";
      body.setAttribute("aria-busy", "true");
      void fetch(url, { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          // Same-origin HTML from the writer's own renderer, as on the rest of the page.
          body.outerHTML = await response.text();
          fold.dataset.foldState = "loaded";
        })
        .catch(() => {
          delete fold.dataset.foldState;
          body.removeAttribute("aria-busy");
        });
    },
    true,
  );
}
