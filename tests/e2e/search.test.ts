import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  setInputValue,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const SEARCH_URL = new URL("/search", USER_URL).toString();

async function expectNoOverflow(view: Bun.WebView): Promise<void> {
  expect(
    await view.evaluate<boolean>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
    ),
  ).toBe(true);
}

integrationDescribe("search page", () => {
  for (const viewport of ["mobile360", "desktop"] as const) {
    test(`searches and paginates at ${viewport}`, async () => {
      await withPage({ url: SEARCH_URL, viewport }, async (view) => {
        await waitForSelector(view, "[data-search-page]", 20_000);
        await expectNoOverflow(view);

        await setInputValue(view, "[data-search-query]", "keyboard");
        await waitForSelector(view, "[data-search-submit]:not([disabled])");
        await clickSelector(view, "[data-search-submit]");
        await waitForExpression(
          view,
          'new URLSearchParams(window.location.search).get("q") === "keyboard"',
          20_000,
        );
        await waitForSelector(view, "[data-search-result]", 20_000);
        await waitForText(view, "Show us your desk setup", 20_000);
        const cacheControl = await view.evaluate<string | null>(
          'fetch("/search?q=keyboard").then((response) => response.headers.get("cache-control"))',
        );
        expect(cacheControl).toContain("private");
        expect(cacheControl).toContain("no-store");
        await expectNoOverflow(view);
      });
    }, 180_000);
  }

  test("uses the header quick-search box", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-quick-search-input]", 20_000);
      await setInputValue(view, "[data-quick-search-input]", "maintenance");
      await waitForSelector(view, "[data-quick-search-submit]:not([disabled])");
      await clickSelector(view, "[data-quick-search-submit]");
      await waitForExpression(
        view,
        'window.location.pathname === "/search" && new URLSearchParams(window.location.search).get("q") === "maintenance"',
        20_000,
      );
      await waitForSelector(view, "[data-search-result]", 20_000);
      await waitForText(view, "Scheduled maintenance this weekend", 20_000);
      await expectNoOverflow(view);
    });
  }, 180_000);
});
