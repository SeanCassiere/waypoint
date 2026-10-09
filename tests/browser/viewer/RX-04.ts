// RX-04: image files on the writer's stage (the reader's stageCss): dark stage, dimensions after
// load, "Open in gallery" only when the folder has a gallery, image rows navigate fully, and the
// stage fits a phone with the type hidden.
import { deflateSync } from "node:zlib";

import { sharedTokensCss } from "@waypoint/ui";
import type { Page } from "playwright";

import { assert, VIEWPORTS, type ViewerScenario } from "../harness.ts";

/** A solid-colour RGB PNG of the given size. */
function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const row = [0, ...Array.from({ length: width }, () => rgb).flat()];
  const pixels = new Uint8Array(Array.from({ length: height }, () => row).flat());
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts);
}

/** The computed colour of a CSS colour value, through a probe. */
const colour = async (page: Page, value: string): Promise<string> =>
  String(
    await page.evaluate(`(() => { const p = document.createElement("span");
      p.style.backgroundColor = ${JSON.stringify(value)};
      document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; })()`),
  );

const scenario: ViewerScenario = {
  name: "RX-04: writer image stage, dimensions, Open in gallery only with a gallery, rows navigate",
  async run(ctx) {
    const { base } = ctx.writer;
    const created = await ctx.writer.api("/api/collections", {
      title: "Image stage",
      head_path: "index.md",
      files: [
        await ctx.writer.write("index.md", "# Screens\n\nThe audit.\n"),
        await ctx.writer.write("shots/a.png", png(720, 450, [200, 90, 60]), "image/png"),
        await ctx.writer.write("shots/b.png", png(320, 200, [60, 160, 90]), "image/png"),
        await ctx.writer.write("shots/c.png", png(300, 300, [60, 90, 200]), "image/png"),
        await ctx.writer.write("shots/d.png", png(240, 400, [150, 150, 40]), "image/png"),
        await ctx.writer.write("cover.png", png(400, 250, [120, 60, 140]), "image/png"),
      ],
    });
    const latest = new URL(created.latest_url).pathname;

    // Desktop, dark: the dark stage, no frame, dimensions after load, both buttons.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.desktop, colorScheme: "dark" });
      await page.goto(`${base}${latest}shots/a.png`);
      const dark = /prefers-color-scheme:dark\)\{:root\{[^}]*--stage:([^;}]+)/.exec(
        sharedTokensCss,
      )?.[1];
      assert.ok(dark, "the dark --stage token");
      assert.equal(
        await page.evaluate(
          `getComputedStyle(document.querySelector("figure.stage")).backgroundColor`,
        ),
        await colour(page, dark),
        "the stage is the dark --stage",
      );
      assert.equal(await page.locator("iframe").count(), 0, "no frame");
      await page.waitForFunction(
        `/^\\d+×\\d+$/.test(document.querySelector(".wcap [data-dim]").textContent)`,
      );
      assert.equal(await page.locator(".wcap [data-dim]").textContent(), "720×450");
      assert.ok(await page.getByRole("link", { name: "Open in gallery" }).isVisible());
      assert.ok(await page.getByRole("link", { name: "Download", exact: true }).isVisible());

      await page.goto(`${base}${latest}cover.png`);
      await page.locator("figure.stage").waitFor();
      assert.equal(await page.getByRole("link", { name: "Open in gallery" }).count(), 0);
    }

    // From the head file, an image row in the Files tree navigates to the image page.
    {
      const { page } = await ctx.newPage(VIEWPORTS.desktop);
      await page.goto(`${base}${latest}`);
      await page.locator("iframe.frame").waitFor();
      await page.locator('.tree a[data-file="shots/b.png"]').click();
      await page.waitForURL((url) => url.pathname.endsWith("shots/b.png"));
      await page.locator("figure.stage").waitFor();
      assert.equal(await page.locator("iframe").count(), 0, "no frame after the click");
    }

    // Phone: the stage fits, the type is hidden.
    {
      const { page } = await ctx.newPage({ ...VIEWPORTS.phone, mobile: true });
      await page.goto(`${base}${latest}shots/a.png`);
      await page.waitForFunction(`document.querySelector("[data-stage-img]").complete`);
      assert.equal(await page.locator(".wcap .ty").isVisible(), false, "type hidden on phones");
      const width = Number(
        await page.evaluate(
          `document.querySelector("[data-stage-img]").getBoundingClientRect().width`,
        ),
      );
      assert.ok(width > 0 && width <= 366, `the image is ${width} px wide at 390`);
    }
  },
};
export default scenario;
