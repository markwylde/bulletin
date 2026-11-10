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

      await setInputValue(view, "[data-grid-action]", "read");

      const forumId = await view.evaluate<string>(
        "document.querySelector('[data-grid-row-bulk]')?.getAttribute('data-grid-row-bulk') ?? ''",
      );
      expect(forumId).not.toBe("");
      await setInputValue(view, "[data-grid-scope]", forumId);

      // Row bulk: every mask grants read on one forum.
      await clickSelector(view, `[data-grid-row-bulk="${forumId}"]`);
      await waitForSelector(view, '[data-toast-tone="success"]');
      await waitForExpression(
        view,
        `[...document.querySelectorAll('[data-grid-cell^="${forumId}:"]')].every(
          (cell) => cell.getAttribute('data-grid-allowed') === 'true'
        )`,
        20_000,
      );

      // Column bulk: the new mask grants read on every forum.
      await clickSelector(view, `[data-grid-column-bulk="${key}"]`);
      await waitForSelector(view, '[data-toast-tone="success"]');
      await waitForExpression(
        view,
        `[...document.querySelectorAll('[data-grid-cell$=":${key}:read"]')].every(
          (cell) => cell.getAttribute('data-grid-allowed') === 'true'
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
