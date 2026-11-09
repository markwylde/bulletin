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

// Run against the full stack in development mode:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

integrationDescribe("admin log view", () => {
  test("filters the log by action at 360 px", async () => {
    await withPage({ url: `${STAFF_URL}/settings/board`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, "[data-form]");
      await waitForExpression(
        view,
        "document.querySelector('[data-form-field=\"boardName\"] input')?.value.length > 0",
      );
      await clickSelector(view, "[data-form-submit]");
      await waitForSelector(view, '[data-toast-tone="success"]');

      await view.navigate(`${STAFF_URL}/log`);
      await waitForSelector(view, '[data-page="admin-log"]');
      await waitForSelector(view, "[data-card-view]");

      await setInputValue(view, "[data-log-filter-action]", "board.settings.update");
      await clickSelector(view, "[data-log-filters] button[type=submit]");
      await waitForExpression(
        view,
        `[...document.querySelectorAll("[data-card-row]")].length > 0`,
        20_000,
      );

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 120_000);
});
