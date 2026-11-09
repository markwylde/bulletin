import { describe, expect, test } from "bun:test";
import { loginAs, waitForExpression, waitForSelector, withPage } from "@bulletin/test-utils/e2e";

// Run against the full stack in development mode:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080";

integrationDescribe("staff data table", () => {
  test("renders rows as cards with reachable actions at 360 px", async () => {
    await withPage({ url: `${STAFF_URL}/dev/blocks`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      await waitForSelector(view, '[data-page="dev-blocks"]');
      await waitForSelector(view, "[data-card-view]");

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
      expect(
        await view.evaluate<number>(
          "document.querySelectorAll('[data-card-view] [data-card-row]').length",
        ),
      ).toBe(2);

      await view.evaluate('document.querySelector("[data-row-action=\\"1\\"]")?.click()');
      await waitForExpression(
        view,
        "document.querySelector('[data-active-row]')?.getAttribute('data-active-row') === '1'",
      );

      await view.evaluate(`(() => {
        const select = document.querySelector("[data-sort-select]");
        if (!select) return false;
        select.value = "posts";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);
      await waitForExpression(
        view,
        "document.querySelector('[data-card-view] [data-card-row]')?.getAttribute('data-card-row') === '2'",
      );

      await view.evaluate('document.querySelector("[data-page-next]")?.click()');
      await waitForExpression(
        view,
        "document.querySelector('[data-table]')?.getAttribute('data-page') === '2'",
      );
      expect(
        await view.evaluate<number>(
          "document.querySelectorAll('[data-card-view] [data-card-row]').length",
        ),
      ).toBe(2);

      await view.evaluate('document.querySelector("[data-card-view] [data-card-select]")?.click()');
      await waitForSelector(view, "[data-bulk-actions]");
      await view.evaluate('document.querySelector("[data-bulk-action=\\"archive\\"]")?.click()');
      await waitForExpression(
        view,
        "document.querySelector('[data-last-bulk]')?.getAttribute('data-last-bulk') === '1'",
      );

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 120_000);
});
