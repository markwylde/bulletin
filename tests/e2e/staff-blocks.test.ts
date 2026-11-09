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

  test("shows a translated inline error and does not submit an out-of-range number", async () => {
    await withPage({ url: `${STAFF_URL}/dev/blocks`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, "[data-dev-form]");

      await setInputValue(view, "[data-locale-switch]", "en");
      await waitForExpression(view, "document.documentElement.lang === 'en'");

      await setInputValue(view, '[data-form-field="count"] input', "11");
      await clickSelector(view, "[data-dev-form] [data-form-submit]");
      await waitForSelector(view, '[data-dev-form] [data-form-error="count"]');

      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-form-error=\"count\"]')?.textContent ?? ''",
        ),
      ).toContain("Must be at most 10.");
      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-submit-count]')?.getAttribute('data-submit-count') ?? ''",
        ),
      ).toBe("0");

      await setInputValue(view, '[data-form-field="count"] input', "5");
      await clickSelector(view, "[data-dev-form] [data-form-submit]");
      await waitForExpression(
        view,
        "document.querySelector('[data-submit-count]')?.getAttribute('data-submit-count') === '1'",
      );
    });
  }, 120_000);
});
