import { errorToast } from "./toast.ts";

type ElementType<T extends Element> = abstract new () => T;

/** querySelector, optionally checked against an element type (no unchecked casts). */
export function $(selector: string, root?: ParentNode): HTMLElement | null;
export function $<T extends Element>(
  selector: string,
  type: ElementType<T>,
  root?: ParentNode,
): T | null;
export function $(
  selector: string,
  typeOrRoot?: ParentNode | ElementType<Element>,
  root: ParentNode = document,
): Element | null {
  if (typeof typeOrRoot === "function") {
    const found = root.querySelector(selector);
    return found instanceof typeOrRoot ? found : null;
  }
  const found = (typeOrRoot ?? document).querySelector(selector);
  return found instanceof HTMLElement ? found : null;
}
export function $$(selector: string, root?: ParentNode): HTMLElement[];
export function $$<T extends Element>(
  selector: string,
  type: ElementType<T>,
  root?: ParentNode,
): T[];
export function $$(
  selector: string,
  typeOrRoot?: ParentNode | ElementType<Element>,
  root: ParentNode = document,
): Element[] {
  const type = typeof typeOrRoot === "function" ? typeOrRoot : HTMLElement;
  const scope = typeof typeOrRoot === "function" ? root : (typeOrRoot ?? document);
  return [...scope.querySelectorAll(selector)].filter((found) => found instanceof type);
}
export function shellRoot(): HTMLElement | null {
  return $("[data-viewer]");
}
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  node.append(...children);
  return node;
}
/** Runs an async handler from an event listener. A failure shows an error toast, "Couldn't
 *  <onError>", or is passed to `onError` when that's a function (inline errors). */
export function run(work: () => Promise<void>, onError: string | ((cause: unknown) => void)): void {
  work().catch((cause: unknown) => {
    if (typeof onError === "string") errorToast(onError, cause);
    else onError(cause);
  });
}
export function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
