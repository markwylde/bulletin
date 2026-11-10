import { describe, expect, test } from "bun:test";
import { VIEWPORTS, type ViewportName, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

integrationDescribe("board index", () => {
  for (const viewportName of VIEWPORT_NAMES) {
    const viewport = VIEWPORTS[viewportName];

    test(`lists categories and forums at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
      await withPage({ url: USER_URL, viewport: viewportName }, async (view) => {
        await waitForSelector(view, "[data-board-index]:not([hidden])", 20_000);

        expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(
          viewport.width,
        );
        expect(
          await view.evaluate<number>("document.querySelectorAll('[data-forum-row]').length"),
        ).toBeGreaterThan(0);
        expect(
          await view.evaluate<number>("document.querySelectorAll('[data-category]').length"),
        ).toBeGreaterThan(0);

        const href = await view.evaluate<string | null>(
          'document.querySelector("[data-forum-link]")?.getAttribute("href") ?? null',
        );

        expect(href).toMatch(/^\/forum\/\d+-/);
      });
    }, 90_000);
  }
});
