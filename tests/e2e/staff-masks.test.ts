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

integrationDescribe("staff permission masks", () => {
  test("bulk-toggles read on a category and inheriting forums follow", async () => {
    await withPage({ url: `${STAFF_URL}/permissions`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="masks"]');
      await waitForSelector(view, "[data-mask-create]", 20_000);
      await waitForExpression(view, "!document.querySelector('[data-matrix-disabled]')", 20_000);
      expect(
        await view.evaluate<boolean>(
          `[...document.querySelectorAll('[data-matrix-scroll]')].every(
            (element) => element.scrollWidth <= element.clientWidth + 1
          )`,
        ),
      ).toBe(true);

      const stamp = Date.now();
      const key = `e2e_mask_${stamp}`;

      await setInputValue(view, '[data-mask-create-field="key"]', key);
      await setInputValue(view, '[data-mask-create-field="title"]', `E2E Mask ${stamp}`);
      await clickSelector(view, "[data-mask-create-submit]");
      await waitForSelector(view, `[data-mask-row="${key}"]`, 20_000);
      await clickSelector(view, `[data-mask-edit="${key}"]`);
      await waitForSelector(view, `[data-mask-editor="${key}"]`);

      const category = await view.evaluate<string>(
        "document.querySelector('[data-bulk-category]')?.options[0]?.value ?? ''",
      );
      expect(category).not.toBe("");

      await setInputValue(view, "[data-bulk-category]", category);
      await setInputValue(view, "[data-bulk-action]", "read");
      await clickSelector(view, "[data-bulk-submit]");
      await waitForSelector(view, '[data-toast-tone="success"]');

      await waitForExpression(
        view,
        `[...document.querySelectorAll('[data-mask-matrix] tbody tr')].some((row) =>
          row.querySelector('[data-matrix-cell$=":read"][data-allowed="true"]') &&
          row.querySelector('[data-matrix-inherits]')
        )`,
        20_000,
      );

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);

      await clickSelector(view, "[data-mask-delete]");
      await waitForExpression(view, `!document.querySelector('[data-mask-row="${key}"]')`, 20_000);
    });
  }, 180_000);
});
