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

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

integrationDescribe("staff auto-promotion", () => {
  test("creates and deletes a promotion rule", async () => {
    await withPage({ url: `${STAFF_URL}/promotions`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="promotions"]');
      await waitForSelector(view, "[data-promotion-from]", 20_000);

      const members = await view.evaluate<string>(
        `(() => {
          const select = document.querySelector('[data-promotion-from]');
          return select ? [...select.options].find((option) => option.textContent === 'Members')?.value ?? '' : '';
        })()`,
      );
      const superModerators = await view.evaluate<string>(
        `(() => {
          const select = document.querySelector('[data-promotion-to]');
          return select ? [...select.options].find((option) => option.textContent === 'Super Moderators')?.value ?? '' : '';
        })()`,
      );

      expect(members).not.toBe("");
      expect(superModerators).not.toBe("");

      await setInputValue(view, "[data-promotion-from]", members);
      await setInputValue(view, "[data-promotion-to]", superModerators);

      const threshold = 30 + (Date.now() % 100);
      await setInputValue(
        view,
        '[data-promotion-criterion="days_since_joining"]',
        String(threshold),
      );
      await clickSelector(view, "[data-promotion-save]");
      await waitForSelector(view, '[data-toast-tone="success"]');

      await waitForExpression(
        view,
        `[...document.querySelectorAll('[data-promotion-row]')].some((row) =>
          (row.textContent ?? '').includes('≥ ${threshold}')
        )`,
        20_000,
      );

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);

      const clicked = await view.evaluate<boolean>(`(() => {
        const row = [...document.querySelectorAll('[data-promotion-row]')].find((candidate) =>
          (candidate.textContent ?? '').includes('≥ ${threshold}')
        );
        const button = row?.querySelector('[data-promotion-edit]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      })()`);
      expect(clicked).toBe(true);
      await clickSelector(view, "[data-promotion-delete]");
      await waitForExpression(
        view,
        `![...document.querySelectorAll('[data-promotion-row]')].some((row) =>
          (row.textContent ?? '').includes('≥ ${threshold}')
        )`,
        20_000,
      );
    });
  }, 180_000);
});
