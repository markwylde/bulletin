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
const MEMBERS_URL = new URL("/members", USER_URL).toString();

integrationDescribe("member directory", () => {
  test("searches and filters the member list at 360px", async () => {
    await withPage({ url: MEMBERS_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-member-list]", 20_000);
      await waitForSelector(view, "[data-member-card]", 20_000);
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
        ),
      ).toBe(true);

      await setInputValue(view, "[data-member-search]", "Regular Member One");
      await waitForSelector(view, "[data-member-filter-submit]:not([disabled])");
      await clickSelector(view, "[data-member-filter-submit]");
      await waitForExpression(
        view,
        'new URLSearchParams(window.location.search).get("q") === "Regular Member One"',
        20_000,
      );
      await waitForSelector(view, "[data-member-card]", 20_000);
      await waitForText(view, "Regular Member One", 20_000);

      await view.navigate(MEMBERS_URL);
      await waitForSelector(view, "[data-member-list]", 20_000);
      await setInputValue(view, "[data-member-sort]", "posts");
      await clickSelector(view, "[data-member-filter-submit]");
      await waitForExpression(
        view,
        'new URLSearchParams(window.location.search).get("sort") === "posts"',
        20_000,
      );
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
        ),
      ).toBe(true);
    });
  }, 180_000);

  test("shows who's online and the leaderboard at 360px", async () => {
    await withPage(
      { url: new URL("/members/online", USER_URL).toString(), viewport: "mobile360" },
      async (view) => {
        await waitForSelector(view, "[data-online-page]", 20_000);
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
          ),
        ).toBe(true);

        await view.navigate(new URL("/leaderboards", USER_URL).toString());
        await waitForSelector(view, "[data-leaderboards-page]", 20_000);
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
          ),
        ).toBe(true);
      },
    );
  }, 120_000);

  test("a guest visit to the member list records presence", async () => {
    await withPage({ url: MEMBERS_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-member-list]", 20_000);
      await Bun.sleep(500);

      await view.navigate(new URL("/members/online", USER_URL).toString());
      await waitForSelector(view, "[data-online-page]", 20_000);
      await waitForSelector(view, "[data-online-counts]", 20_000);
      const counts = await view.evaluate<string>(
        'document.querySelector("[data-online-counts]")?.textContent ?? ""',
      );
      expect(counts).toContain("guest");
      expect(counts).not.toContain("No guests");
    });
  }, 120_000);
});
