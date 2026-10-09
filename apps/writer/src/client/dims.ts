import { $$ } from "./dom.ts";

const bound = new WeakSet<Element>();

/** Image sizes after load: in every `[data-dims]` scope under `root` (and `root` itself), the
 *  first image's natural size becomes the text of each `[data-dim]` ("720×450"), and each
 *  `[data-dim-wrap]` loses `hidden`. Each scope binds once, however often this runs; a failed
 *  load changes nothing. */
export function fillDims(root: ParentNode = document): void {
  const scopes = $$("[data-dims]", Element, root);
  if (root instanceof Element && root.matches("[data-dims]")) scopes.unshift(root);
  for (const scope of scopes) {
    if (bound.has(scope)) continue;
    const image = scope.querySelector("img");
    if (!image) continue;
    bound.add(scope);
    const fill = () => {
      if (!image.naturalWidth) return;
      for (const dim of $$("[data-dim]", Element, scope))
        dim.textContent = `${image.naturalWidth}×${image.naturalHeight}`;
      for (const wrap of $$("[data-dim-wrap]", HTMLElement, scope)) wrap.hidden = false;
    };
    if (image.complete && image.naturalWidth) fill();
    else image.addEventListener("load", fill, { once: true });
  }
}
