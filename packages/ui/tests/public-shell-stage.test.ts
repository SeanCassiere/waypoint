import { describe, expect, it } from "vitest";

import {
  encodeLinkPath,
  FRAME_DENIED_BODY,
  IMAGE_ERROR_HEADING,
  imageTypeLabel,
  isStageImage,
  publicShellScript,
  renderPublicShell,
  stageCss,
  type PublicShellOptions,
} from "../src/index.ts";
import { stageScript } from "../src/public-shell/script.ts";
import { sharedTokensCss } from "../src/tokens.ts";

// RX-04: image files on a stage (<img>, fit the width, scroll when tall), a caption, and an
// error card from a <template> when the image fails.
const fileHref = (path: string) => `../${encodeLinkPath(path)}`;
const base: PublicShellOptions = {
  title: "Checkout audit",
  files: [{ path: "shots/a.png" }],
  head: "shots/a.png",
  current: "shots/a.png",
  fileHref,
  frameBase: "https://reader.example/x/shl_a.cap/r/rpub/",
  updatedAt: null,
  snapshotAt: null,
};
const markup = (html: string): string =>
  html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, "");
const image = (path: string, mime = "image/png", size: number | null = 2970): string =>
  markup(
    renderPublicShell({
      ...base,
      files: [{ path }],
      head: path,
      current: path,
      image: { mime, size },
    }),
  );
// oxlint-disable-next-line typescript/no-implied-eval -- Parsing the emitted script is the point.
const parse = (source: string): unknown => new Function(source);

describe("isStageImage", () => {
  it.each([
    "image/png",
    "IMAGE/PNG",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
    "image/png; foo=bar",
  ])("shows %s on the stage", (mime) => expect(isStageImage(mime)).toBe(true));
  it.each(["image/bmp", "image/tiff", "text/plain"])("keeps %s off the stage", (mime) =>
    expect(isStageImage(mime)).toBe(false),
  );
});

describe("imageTypeLabel", () => {
  it.each([
    ["image/png", "PNG image"],
    ["image/jpeg", "JPEG image"],
    ["image/jpg", "JPEG image"],
    ["image/svg+xml", "SVG image"],
    ["image/webp", "WEBP image"],
    ["image/gif", "GIF image"],
    ["image/avif", "AVIF image"],
    ["IMAGE/PNG; foo=bar", "PNG image"],
  ])("labels %s as %s", (mime, label) => expect(imageTypeLabel(mime)).toBe(label));
});

describe("image stage (RX-04)", () => {
  it("renders the stage, the caption and the error template instead of the frame", () => {
    const html = image("shots/a.png");
    expect(html).toContain(
      `<main id="main" class="imgmain"><figure class="stage" id="doc" tabindex="-1" aria-label="shots/a.png"><div class="fit"><img src="${base.frameBase}shots/a.png" alt="shots/a.png" referrerpolicy="no-referrer"></div></figure><p class="icap"><b>a.png</b><span>2.9 KB</span><span class="ty">PNG image</span></p><template id="imgerr"><div class="imgerr" role="status"><h2>`,
    );
    expect(html).toContain(
      `This image can't be shown right now</h2><p>${FRAME_DENIED_BODY}</p><a class="btn" href="${fileHref("shots/a.png")}">Reload</a>`,
    );
    expect(IMAGE_ERROR_HEADING).toBe("This image can't be shown right now");
    // The heading's icon is FB3's alert, at the default size.
    expect(html).toMatch(/<h2><svg class="ic" [^>]*>.*?<\/svg>This image/);
    expect(html).not.toContain("<iframe");
  });

  it("leaves the Reload link to the shell's button family", () => {
    expect(stageCss).not.toContain(".imgerr a{");
  });

  it("shows the download card when download is set too", () => {
    const html = markup(
      renderPublicShell({
        ...base,
        image: { mime: "image/png", size: 2970 },
        download: { mime: "image/png", size: 2970 },
      }),
    );
    expect(html).toContain('<div class="dl">');
    expect(html).not.toContain('class="stage"');
    expect(html).not.toContain('id="imgerr"');
  });

  it("omits the size when it is unknown", () => {
    const html = image("shots/a.png", "image/svg+xml", null);
    expect(html).toContain('<p class="icap"><b>a.png</b><span class="ty">SVG image</span></p>');
  });

  it("escapes a hostile path everywhere and shows bidi controls as U+FFFD", () => {
    const name = `"><img src=x onerror=alert(1)>'&\u202Egnp.exe.png`;
    const html = image(`shots/${name}`);
    const shown = `&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;\uFFFDgnp.exe.png`;
    expect(html).toContain(`aria-label="shots/${shown}"`);
    expect(html).toContain(`alt="shots/${shown}"`);
    expect(html).toContain(`<b>${shown}</b>`);
    expect(html).not.toContain("<img src=x");
    const reload = /<a class="btn" href="([^"]*)">Reload<\/a>/.exec(html)?.[1];
    expect(reload).toBeDefined();
    expect(reload).not.toMatch(/[<>"]/);
    expect(reload).toContain("&#39;&amp;");
    // Labels never carry the override; only the Reload URL keeps the real path.
    expect(html.replace(reload ?? "", "")).not.toContain("\u202E");
  });

  it("swaps in the error card from a self-contained, readable script", () => {
    expect(() => parse(stageScript)).not.toThrow();
    expect(stageScript).toContain("naturalWidth");
    expect(stageScript).toContain("{ once: true }");
    expect(stageScript).not.toContain("//");
    expect(stageScript).not.toContain("/*");
    for (const line of stageScript.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
    expect(publicShellScript.endsWith(stageScript)).toBe(true);
  });

  it("uses only shared tokens in balanced CSS", () => {
    expect(stageCss.split("{").length).toBe(stageCss.split("}").length);
    expect(stageCss).toContain("@media(max-width:599.98px){");
    const used = [...stageCss.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) expect(sharedTokensCss).toContain(`${name}:`);
  });
});
