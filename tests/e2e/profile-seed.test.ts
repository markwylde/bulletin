import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the seeded full stack:
//   docker compose up -d --watch

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

integrationDescribe("member-profiles seed", () => {
  test("shows seeded profiles, fields, badges, friends and directory data at 360px", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        await view.navigate(new URL("/account", USER_URL).toString());
        await waitForSelector(view, "[data-account-profile-view]", 20_000);
        await clickSelector(view, "[data-account-profile-view]");
        await waitForSelector(view, "[data-profile-page]", 20_000);
        await waitForSelector(view, "[data-profile-custom-title]", 20_000);
        await waitForSelector(view, "[data-profile-field-row]", 20_000);
        await waitForSelector(view, "[data-profile-badge]", 20_000);
        await waitForSelector(view, "[data-profile-friend]", 20_000);
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
          ),
        ).toBe(true);

        await view.navigate(new URL("/leaderboards", USER_URL).toString());
        await waitForSelector(view, "[data-leaderboards-page]", 20_000);
        await waitForSelector(view, "[data-leaderboard-entry]", 20_000);

        await view.navigate(new URL("/members/online", USER_URL).toString());
        await waitForSelector(view, "[data-online-page]", 20_000);
        await waitForSelector(view, "[data-online-member]", 20_000);

        await view.navigate(new URL("/members", USER_URL).toString());
        await waitForSelector(view, "[data-member-card]", 20_000);
        await waitForExpression(
          view,
          'document.querySelectorAll("[data-member-card]").length > 1',
          20_000,
        );
      },
    );
  }, 180_000);
});
