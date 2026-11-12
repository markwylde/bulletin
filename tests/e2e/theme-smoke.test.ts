import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME_NAME } from "@bulletin/templates";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 1.3: a 360 px smoke render for every theme the seed installs. `THEMES` grows when
// task 5.2 adds the child theme and the member chooser serves it; until then the default
// theme is the only reachable one.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

const THEMES = [DEFAULT_THEME_NAME] as const;

const PAGES = [
  { path: "/", marker: "[data-board-index]", member: false },
  { path: "/forum/5-off-topic", marker: "[data-forum-page]", member: false },
  { path: "/members", marker: "[data-member-list]", member: false },
  { path: "/leaderboards", marker: "[data-leaderboards-page]", member: false },
  { path: "/search", marker: "[data-search-page]", member: false },
  { path: "/account", marker: "[data-account-page]", member: true },
  { path: "/conversations", marker: "[data-conversations-page]", member: true },
] as const;

integrationDescribe("seed theme smoke renders", () => {
  for (const theme of THEMES) {
    test(`renders the ${theme} theme at 360px`, async () => {
      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        for (const page of PAGES.filter((entry) => !entry.member)) {
          await view.navigate(new URL(page.path, USER_URL).toString());
          await waitForSelector(view, page.marker, 20_000);
          await waitForSelector(view, "[data-theme-header]", 20_000);
          await waitForSelector(view, "[data-theme-footer]", 20_000);

          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        }

        await view.navigate(USER_URL);
        await loginAs(view, "member-1");

        for (const page of PAGES.filter((entry) => entry.member)) {
          await view.navigate(new URL(page.path, USER_URL).toString());
          await waitForSelector(view, page.marker, 20_000);
          await waitForSelector(view, "[data-theme-header]", 20_000);
          await waitForSelector(view, "[data-theme-footer]", 20_000);

          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        }
      });
    }, 180_000);
  }
});
