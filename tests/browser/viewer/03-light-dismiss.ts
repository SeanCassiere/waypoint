import { z } from "zod";

import { assert, openState, type ViewerScenario } from "../harness.ts";
import { baseline } from "./_baseline.ts";

const scenario: ViewerScenario = {
  name: "light dismiss, menu items, touch taps, popover origins at 390/744/1024/1440",
  async run(ctx) {
    const { base } = ctx.writer;
    const { pageErrors } = ctx;
    const { latest, pinned } = await baseline(ctx);
    // Light dismiss (owner feedback): every popover closes on a press outside it, including a
    // press inside the document iframe (whose events never reach the shell), with a mouse and
    // with touch, at phone, iPad mini, iPad and desktop widths. Entrances grow from the trigger.
    const widths = [
      { width: 390, height: 844, touch: true },
      { width: 744, height: 1133, touch: true },
      { width: 1024, height: 768, touch: true },
      { width: 1024, height: 768, touch: false },
      { width: 1440, height: 900, touch: false },
    ];
    // Browser-side checks are strings: this project type-checks tests without the DOM lib.
    const geometrySchema = z.object({
      rect: z.object({
        left: z.number(),
        right: z.number(),
        top: z.number(),
        bottom: z.number(),
        height: z.number(),
      }),
      x: z.number(),
      y: z.number(),
      trigger: z
        .object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() })
        .nullable(),
    });
    for (const { width, height, touch } of widths) {
      const sized = await ctx.browser.newContext({
        viewport: { width, height },
        hasTouch: touch,
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const view = await sized.newPage();
      view.on("pageerror", (error) => pageErrors.push(`${width}px: ${error.message}`));
      await view.goto(`${base}${latest}`);
      await view.locator("iframe.frame").waitFor();
      // Below 600 px menus are bottom sheets; up to 760 px the tab bar holds Copy and More.
      const phone = width < 600;
      const tabbar = width <= 760;
      const triggers: [string, string][] = [
        [
          "copy-menu",
          tabbar ? '.tabbar [popovertarget="copy-menu"]' : 'header [popovertarget="copy-menu"]',
        ],
        [
          "more-menu",
          tabbar ? '.tabbar [popovertarget="more-menu"]' : 'header [popovertarget="more-menu"]',
        ],
        ["rev-menu", ".revbtn"],
        ["health-pop", "header .health"],
      ];
      const isOpen = async (id: string) => (await view.evaluate(openState(id))) === true;
      const closed = (id: string) =>
        view
          .waitForFunction(`!(${openState(id)})`, undefined, { timeout: 2000 })
          .catch(() => undefined);
      const press = async (x: number, y: number) => {
        if (touch) await view.touchscreen.tap(x, y);
        else await view.mouse.click(x, y);
      };
      const open = async (id: string, selector: string) => {
        const trigger = view.locator(selector).first();
        if (touch) await trigger.tap();
        else await trigger.click();
        await view.waitForFunction(openState(id));
        await view.waitForTimeout(200);
      };
      for (const [id, selector] of triggers) {
        const label = `${id} at ${width}px (${touch ? "touch" : "mouse"})`;
        await open(id, selector);
        // The box grows out of its trigger: phones slide a bottom sheet up from the bottom edge;
        // elsewhere the origin is the corner nearest the trigger.
        const { rect, x, y, trigger } = geometrySchema.parse(
          JSON.parse(
            String(
              await view.evaluate(`(() => {
                const box = document.querySelector("#${id} > .mbox");
                const [x = 0, y = 0] = getComputedStyle(box).transformOrigin.split(" ").map(parseFloat);
                const trigger = document.querySelector(${JSON.stringify(selector)});
                return JSON.stringify({ rect: box.getBoundingClientRect(), x, y, trigger: trigger?.getBoundingClientRect() ?? null });
              })()`),
            ),
          ),
        );
        if (phone) {
          assert.ok(Math.abs(y - rect.height) < 2, `${label}: origin at the bottom edge`);
          assert.ok(Math.abs(rect.bottom - height) < 2, `${label}: sheet sits on the bottom edge`);
        } else {
          assert.ok(trigger, `${label}: trigger found`);
          const below = rect.top >= trigger.bottom - 2;
          assert.ok(
            Math.abs(rect.top + y - (below ? rect.top : rect.bottom)) < 2,
            `${label}: vertical origin faces the trigger`,
          );
          const nearest =
            Math.abs(rect.left - trigger.left) <= Math.abs(rect.right - trigger.right)
              ? rect.left
              : rect.right;
          assert.ok(
            Math.abs(rect.left + x - nearest) < 2,
            `${label}: horizontal origin on the trigger's side`,
          );
        }
        // A press inside the document iframe (away from the popover's box) closes it.
        const frame = await view.locator("iframe.frame").boundingBox();
        assert.ok(frame);
        const spot = [
          [frame.x + frame.width - 16, frame.y + frame.height - 16],
          [frame.x + 16, frame.y + frame.height - 16],
          [frame.x + 16, frame.y + 16],
          [frame.x + frame.width - 16, frame.y + 16],
        ].find(
          ([px = 0, py = 0]) =>
            px < rect.left - 24 ||
            px > rect.right + 24 ||
            py < rect.top - 24 ||
            py > rect.bottom + 24,
        );
        assert.ok(spot, `${label}: part of the document is uncovered`);
        await press(spot[0] ?? 0, spot[1] ?? 0);
        await closed(id);
        assert.equal(await isOpen(id), false, `${label}: a press in the iframe closes it`);
        // So does a press elsewhere in the shell (the status line, or the phone sheet's scrim).
        await open(id, selector);
        const bar = await view.locator("header.bar").boundingBox();
        assert.ok(bar);
        const below = bar.y + bar.height + (touch ? 6 : 2);
        const outside = [touch ? width / 2 : bar.x + 4, 8, width - 8].find(
          // Clear of the box by more than touch adjustment's reach.
          (px) =>
            px < rect.left - 24 ||
            px > rect.right + 24 ||
            below < rect.top - 24 ||
            below > rect.bottom + 24,
        );
        assert.ok(outside !== undefined, `${label}: part of the status line is uncovered`);
        await press(outside, below);
        await closed(id);
        assert.equal(await isOpen(id), false, `${label}: a press outside closes it`);
        // The closing press doesn't also act on what's beneath (on phones, the status line's
        // tap target would open the History sheet).
        assert.equal(
          await view.evaluate(
            'document.querySelector("#shell")?.classList.contains("open") === true',
          ),
          false,
          `${label}: the closing press doesn't reach the page beneath`,
        );
        assert.equal(new URL(view.url()).pathname, latest);
        // And Esc.
        await open(id, selector);
        await view.keyboard.press("Escape");
        assert.equal(await isOpen(id), false, `${label}: Esc closes it`);
      }
      // Choosing a menu item closes its menu (the item's action cancels the native hide), and
      // the toast it shows never holds the touch scrim.
      const copyTrigger = triggers[0]?.[1] ?? "";
      await open("copy-menu", copyTrigger);
      const item = view.locator("#copy-menu").getByRole("menuitem", { name: /Collection ID/ });
      if (touch) await item.tap();
      else await item.click();
      await closed("copy-menu");
      assert.equal(await isOpen("copy-menu"), false, `a menu item closes its menu at ${width}px`);
      await view.locator("[data-toast]").waitFor({ state: "visible", timeout: 4000 });
      await view.locator("[data-toast]").waitFor({ state: "hidden", timeout: 4000 });
      assert.equal(
        await view.evaluate(
          'getComputedStyle(document.querySelector(".pop-scrim")).display === "none" && !document.querySelector(".pop-scrim").classList.contains("linger")',
        ),
        true,
        `no scrim is left behind after the toast at ${width}px`,
      );
      await open("rev-menu", ".revbtn");
      const historyItem = view
        .locator("#rev-menu")
        .getByRole("button", { name: /Open History panel/ });
      if (touch) await historyItem.tap();
      else await historyItem.click();
      await closed("rev-menu");
      assert.equal(
        await isOpen("rev-menu"),
        false,
        `Open History panel closes the menu at ${width}px`,
      );
      assert.equal(await view.locator("#tp-history").isVisible(), true);
      await view.keyboard.press("Escape");
      // On touch screens a tap that closes a menu doesn't also follow a link in the document.
      if (touch && !phone) {
        // #1's head file links to notes/b.md.
        await view.goto(`${base}${pinned}`);
        await view.locator("iframe.frame").waitFor();
        const notes = await view
          .frameLocator("iframe.frame")
          .getByRole("link", { name: "Notes" })
          .boundingBox();
        assert.ok(notes);
        await open("health-pop", "header .health");
        await press(notes.x + 4, notes.y + notes.height / 2);
        await closed("health-pop");
        assert.equal(await isOpen("health-pop"), false);
        await view.waitForTimeout(500);
        assert.match(
          String(
            await view.evaluate(
              'document.querySelector("iframe.frame").contentWindow.location.pathname',
            ),
          ),
          /\/index\.md$/,
          `the closing tap didn't follow the document's link at ${width}px`,
        );
      }
      // Esc pressed while focus is inside the document closes an open popover too.
      const frame = await view.locator("iframe.frame").boundingBox();
      assert.ok(frame);
      await press(frame.x + frame.width - 16, frame.y + 16);
      await view.evaluate('document.getElementById("health-pop")?.showPopover()');
      await view.frameLocator("iframe.frame").locator("body").press("Escape");
      assert.equal(await isOpen("health-pop"), false, `Esc inside the document at ${width}px`);
      await sized.close();
    }
  },
};
export default scenario;
