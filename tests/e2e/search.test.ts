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

async function useFreshGuest(view: Bun.WebView): Promise<void> {
  const guest = crypto.randomUUID();
  await view.evaluate(`document.cookie = "bl_guest=${guest}; Path=/"`);
}

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
      await withPage({ url: USER_URL, viewport }, async (view) => {
        await useFreshGuest(view);
        await view.navigate(SEARCH_URL);
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
          'fetch("/search").then((response) => response.headers.get("cache-control"))',
        );
        expect(cacheControl).toContain("private");
        expect(cacheControl).toContain("no-store");
        await expectNoOverflow(view);
      });
    }, 180_000);
  }

  for (const viewport of ["mobile360", "desktop"] as const) {
    test(`paginates and keeps filters at ${viewport}`, async () => {
      await withPage({ url: USER_URL, viewport }, async (view) => {
        await useFreshGuest(view);
        await view.navigate(`${SEARCH_URL}?q=the&kind=posts&sort=date`);
        await waitForSelector(view, "[data-search-result]", 20_000);
        await waitForSelector(view, "[data-search-next]", 20_000);
        const firstResult = await view.evaluate<string>(
          'document.querySelector("[data-search-result]")?.getAttribute("data-search-result") ?? ""',
        );

        expect(
          await view.evaluate<string>('document.querySelector("[data-search-kind]")?.value ?? ""'),
        ).toBe("posts");
        expect(
          await view.evaluate<string>('document.querySelector("[data-search-sort]")?.value ?? ""'),
        ).toBe("date");

        await clickSelector(view, "[data-search-next]");
        await waitForExpression(
          view,
          '(() => { const p = new URLSearchParams(window.location.search); return p.get("page") === "2" && p.get("q") === "the" && p.get("kind") === "posts" && p.get("sort") === "date"; })()',
          20_000,
        );
        await waitForSelector(view, "[data-search-result]", 20_000);
        const secondResult = await view.evaluate<string>(
          'document.querySelector("[data-search-result]")?.getAttribute("data-search-result") ?? ""',
        );

        expect(secondResult).not.toBe(firstResult);
        await expectNoOverflow(view);
      });
    }, 180_000);
  }

  test("refuses a second search inside the group interval", async () => {
    await withPage(
      { url: USER_URL, viewport: "mobile360", allowConsoleErrors: [/429/] },
      async (view) => {
        await useFreshGuest(view);
        const result = await view.evaluate<{
          readonly first: number;
          readonly second: number;
          readonly flooded: boolean;
        }>(
          `(async () => {
          const first = await fetch("/search?q=floodtest&kind=posts");
          const second = await fetch("/search?q=floodtest&kind=posts");
          const body = await second.text();
          return { first: first.status, second: second.status, flooded: body.includes("data-search-flood") };
        })()`,
        );

        expect(result.first).toBe(200);
        expect(result.second).toBe(429);
        expect(result.flooded).toBe(true);
      },
    );
  }, 180_000);

  test("uses the header quick-search box", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await useFreshGuest(view);
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
