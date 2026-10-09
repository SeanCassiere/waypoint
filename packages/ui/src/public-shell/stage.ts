import { FRAME_DENIED_BODY } from "../denial-copy.ts";
import { icon } from "../icons.ts";
import { esc } from "./text.ts";

const STAGE_IMAGE = /^image\/(?:png|jpe?g|gif|webp|avif|svg\+xml)$/;
/** Images the stage shows with <img> (the same set the writer's gallery uses). */
export function isStageImage(mime: string): boolean {
  return STAGE_IMAGE.test(mime.split(";", 1)[0]!.trim().toLowerCase());
}

/** "PNG image", "JPEG image", "SVG image", "WEBP image", "GIF image", "AVIF image". */
export function imageTypeLabel(mime: string): string {
  const subtype = mime.split(";", 1)[0]!.trim().toLowerCase().slice("image/".length);
  if (subtype === "jpeg" || subtype === "jpg") return "JPEG image";
  if (subtype === "svg+xml") return "SVG image";
  return `${subtype.toUpperCase()} image`;
}

export const IMAGE_ERROR_HEADING: string = "This image can't be shown right now";

/** The reader's stage: figure, caption and the error template. Every value is escaped here. */
export function stageHtml(options: {
  src: string;
  alt: string;
  name: string;
  size: string | null;
  type: string;
  errorHref: string;
}): string {
  const alt = esc(options.alt);
  const size = options.size === null ? "" : `<span>${esc(options.size)}</span>`;
  // The error card waits in an inert <template>; stageScript swaps it in when the image fails.
  // The heading and body are constants with apostrophes, so they go in as they are.
  return `<figure class="stage" id="doc" tabindex="-1" aria-label="${alt}"><div class="fit"><img src="${esc(options.src)}" alt="${alt}" referrerpolicy="no-referrer"></div></figure><p class="icap"><b>${esc(options.name)}</b>${size}<span class="ty">${esc(options.type)}</span></p><template id="imgerr"><div class="imgerr" role="status"><h2>${icon("alert")}${IMAGE_ERROR_HEADING}</h2><p>${FRAME_DENIED_BODY}</p><a class="btn" href="${esc(options.errorHref)}">Reload</a></div></template>`;
}
