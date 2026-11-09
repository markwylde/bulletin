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
const KEY = "user.placeholder.title";

integrationDescribe("string overrides", () => {
  test("overrides a string and reverts it from the active list", async () => {
    await withPage(
      { url: `${STAFF_URL}/settings/strings`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="string-overrides"]');
        await waitForSelector(view, "[data-strings-search]");

        await setInputValue(view, "[data-strings-search]", KEY);
        await clickSelector(view, "[data-strings-search-button]");
        await waitForSelector(view, `[data-key-result="${KEY}"]`);
        await clickSelector(view, `[data-key-result="${KEY}"]`);
        await waitForExpression(
          view,
          `document.querySelector('[data-selected-key]')?.getAttribute('data-selected-key') === '${KEY}'`,
        );

        await setInputValue(
          view,
          '[data-form-field="en"] textarea',
          "Custom board title from staff",
        );
        await clickSelector(view, "[data-form-submit]");
        await waitForSelector(view, '[data-toast-tone="success"]');

        const rowId = `en::${KEY}`;
        await waitForSelector(view, `[data-card-row="${rowId}"]`);
        await clickSelector(view, `[data-card-row="${rowId}"] [data-revert]`);
        await waitForSelector(view, "[data-confirm-dialog]");
        await clickSelector(view, "[data-confirm-action]");

        await waitForExpression(
          view,
          `!document.querySelector('[data-card-row="${rowId}"]')`,
          20_000,
        );
        expect(
          await view.evaluate<boolean>(`!document.querySelector('[data-card-row="${rowId}"]')`),
        ).toBe(true);
      },
    );
  }, 180_000);
});
