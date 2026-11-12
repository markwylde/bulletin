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

integrationDescribe("staff content filters at mobile360", () => {
  test("adds block and replace words, a blocked domain and saves anti-spam settings", async () => {
    const stamp = Date.now();

    await withPage(
      { url: `${STAFF_URL}/settings/filters`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="filters"]', 20_000);
        await waitForSelector(view, "[data-filter-word]", 20_000);

        await setInputValue(view, "[data-filter-word]", `e2e_block_${stamp}`);
        await clickSelector(view, "[data-filter-word-save]");
        await waitForExpression(
          view,
          `[...document.querySelectorAll('[data-filter-word-row]')].some(
          (element) => element.textContent?.includes(${JSON.stringify(`e2e_block_${stamp}`)})
        )`,
          20_000,
        );

        await setInputValue(view, "[data-filter-word]", `e2e_replace_${stamp}`);
        await setInputValue(view, "[data-filter-mode]", "replace");
        await waitForSelector(view, "[data-filter-replacement]", 20_000);
        await setInputValue(view, "[data-filter-replacement]", "safe-text");
        await clickSelector(view, "[data-filter-word-save]");
        await waitForExpression(
          view,
          `[...document.querySelectorAll('[data-filter-word-row]')].some(
          (element) => element.textContent?.includes("safe-text")
        )`,
          20_000,
        );

        await view.navigate(`${STAFF_URL}/settings/filters`);
        await waitForSelector(view, '[data-page="filters"]', 20_000);
        await waitForSelector(view, "[data-filter-domain]", 20_000);
        await setInputValue(view, "[data-filter-domain]", `blocked-${stamp}.example`);
        await clickSelector(view, "[data-filter-domain-save]");
        await waitForExpression(
          view,
          `[...document.querySelectorAll('[data-filter-domain-row]')].some(
          (element) => element.textContent?.includes(${JSON.stringify(`blocked-${stamp}.example`)})
        )`,
          20_000,
        );

        await setInputValue(view, "[data-filter-duplicate-count]", "4");
        await clickSelector(view, "[data-filter-spam-save]");
        await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);
      },
    );
  }, 180_000);
});
