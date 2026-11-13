/**
 * The chrome's typeface (D79): Recursive, subset by scripts/subset-recursive.sh to the Latin
 * glyphs and the two axes the UI needs (wght 300–1000, MONO 0–1). One file serves both cuts: the
 * sans is MONO 0, and `--mono` is the same file under the family name "Recursive Mono", whose
 * face turns MONO to 1. Documents and renditions never use it (D45 stands for them).
 *
 * The writer and the reader each serve these exact bytes from `CHROME_FONT_PATH`, a
 * content-hashed same-origin path, with `chromeFontHeaders` (immutable), so the shell needs only
 * `font-src 'self'`. Its license (SIL OFL 1.1, packages/ui/fonts/OFL.txt) is in
 * THIRD_PARTY_NOTICES.md, which ships with the writer image and the reader bundle.
 */
import { RECURSIVE_SHA256, RECURSIVE_WOFF2_BASE64 } from "./font-data.ts";

/** Where both apps serve the font: changes whenever its bytes do. */
export const CHROME_FONT_PATH: string = `/assets/font/recursive-${RECURSIVE_SHA256.slice(0, 16)}.woff2`;

/** Response headers for `CHROME_FONT_PATH` (a hashed URL, so cached for a year). */
export const chromeFontHeaders: Readonly<Record<string, string>> = {
  "Content-Type": "font/woff2",
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
};

let decoded: Uint8Array<ArrayBuffer> | undefined;
/** The font's bytes, decoded once on first use (never at module load: the reader's CPU budget). */
export function chromeFontBytes(): Uint8Array<ArrayBuffer> {
  if (!decoded) {
    const text = atob(RECURSIVE_WOFF2_BASE64);
    decoded = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) decoded[i] = text.charCodeAt(i);
  }
  return decoded;
}

/** The two faces over the one file; heads `sharedTokensCss`. */
export const fontFaceCss: string = `@font-face{font-family:"Recursive";src:url(${CHROME_FONT_PATH}) format("woff2");font-weight:300 1000;font-style:normal;font-display:swap}
@font-face{font-family:"Recursive Mono";src:url(${CHROME_FONT_PATH}) format("woff2");font-weight:300 1000;font-style:normal;font-display:swap;font-variation-settings:"MONO" 1}
`;
