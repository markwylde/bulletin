import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

// ADR 0021 staff navigation: icon rail of areas, grouped panel, breadcrumbs and section search.
// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

function path(view: Bun.WebView): Promise<string> {
  return view.evaluate<string>("location.pathname");
}

function openPalette(view: Bun.WebView): Promise<unknown> {
  return view.evaluate(
    'document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))',
  );
}

integrationDescribe("staff navigation", () => {
  test("moves from an area to a group's section on desktop", async () => {
    await withPage({ url: STAFF_URL, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-widget="members"]');

      // The rail lists areas; the panel shows the selected area's groups.
      await clickSelector(view, '[data-area="members"]');
      await waitForSelector(view, '[data-nav-panel="members"]');
      await waitForExpression(view, 'location.pathname === "/members/profiles"');
      await waitForSelector(view, '[data-nav-group="access"] [data-section="groups"]');
      await waitForExpression(
        view,
        'document.querySelector(\'[data-area="members"]\').getAttribute("aria-current") === "page"',
      );

      await clickSelector(view, '[data-nav-group="access"] [data-section="groups"]');
      await waitForExpression(view, 'location.pathname === "/groups"');
      await waitForExpression(
        view,
        'document.querySelector(\'[data-section="groups"]\').getAttribute("aria-current") === "page"',
      );

      // Breadcrumbs: area link, then the current section.
      await waitForExpression(
        view,
        'document.querySelectorAll("[data-breadcrumbs] li").length === 2 && document.querySelector("[data-breadcrumbs] [aria-current]")?.textContent === document.querySelector(\'[data-section="groups"]\').textContent',
      );
      const crumbs = await view.evaluate<{ text: string; href: string | null }[]>(
        `[...document.querySelectorAll("[data-breadcrumbs] li")].map((item) => ({
          text: item.textContent.trim(),
          href: item.querySelector("a")?.getAttribute("href") ?? null,
        }))`,
      );
      expect(crumbs).toHaveLength(2);
      expect(crumbs[0]?.href).toBe("/members/profiles");
      expect(crumbs[1]?.href).toBeNull();

      // The panel follows the page after navigating elsewhere.
      await view.navigate(`${STAFF_URL}/system/health`);
      await waitForSelector(view, '[data-nav-panel="system"]');
    });
  }, 120_000);

  test("opens a section from the search palette", async () => {
    await withPage({ url: STAFF_URL, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-widget="members"]');

      await openPalette(view);
      await waitForExpression(view, 'document.querySelector("[data-command-palette]").open');
      await setInputValue(view, "[data-command-input]", "dead let");
      await waitForSelector(view, '[data-command-option="deadLetters"]');
      await view.evaluate(
        'document.querySelector("[data-command-input]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))',
      );
      await waitForExpression(view, 'location.pathname === "/system/dead-letters"');
      expect(
        await view.evaluate<boolean>('document.querySelector("[data-command-palette]").open'),
      ).toBe(false);
    });
  }, 120_000);

  test("keeps sections a moderator cannot open out of the rail, panel and search", async () => {
    await withPage(
      {
        url: STAFF_URL,
        viewport: "desktop",
        allowConsoleErrors: [/403.*\/api\/staff\/dashboard\/(log|health)/],
      },
      async (view) => {
        await loginAs(view, "super-mod");
        await waitForSelector(view, '[data-widget="members"]');

        const areas = await view.evaluate<string[]>(
          '[...document.querySelectorAll("[data-area]")].map((item) => item.dataset.area)',
        );
        expect(areas).toContain("overview");

        for (const area of areas) {
          await clickSelector(view, `[data-area="${area}"]`);
          await waitForSelector(view, `[data-nav-panel="${area}"]`);
          expect(
            await view.evaluate<boolean>(
              "Boolean(document.querySelector('[data-section=\"boardSettings\"]'))",
            ),
          ).toBe(false);
        }

        await openPalette(view);
        await waitForExpression(view, 'document.querySelector("[data-command-palette]").open');
        await setInputValue(view, "[data-command-input]", "board settings");
        await waitForExpression(
          view,
          "!document.querySelector('[data-command-option=\"boardSettings\"]')",
        );
        await view.evaluate(
          'document.querySelector("[data-command-input]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))',
        );
        await waitForExpression(view, '!document.querySelector("[data-command-palette]").open');

        await view.navigate(`${STAFF_URL}/settings/board`);
        await waitForSelector(view, "[data-not-found]");
        expect(await path(view)).toBe("/settings/board");
        expect(
          await view.evaluate<boolean>(
            "Boolean(document.querySelector('[data-page=\"board-settings\"]'))",
          ),
        ).toBe(false);
      },
    );
  }, 120_000);

  test("uses one drawer for areas and sections at 360 px", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-widget="members"]');

      await clickSelector(view, "[data-menu-toggle]");
      await waitForExpression(view, 'document.querySelector("[data-nav]").dataset.open === "true"');

      // Picking an area in the drawer switches the panel without leaving the page.
      await clickSelector(view, '[data-area="content"]');
      await waitForSelector(view, '[data-nav-panel="content"]');
      expect(await path(view)).toBe("/");

      await clickSelector(view, '[data-section="forums"]');
      await waitForExpression(view, 'location.pathname === "/forums"');
      await waitForExpression(
        view,
        'document.querySelector("[data-nav]").dataset.open === "false"',
      );
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 120_000);
});
