import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();

integrationDescribe("bulk topic actions at mobile360", () => {
  test("locks two selected topics from the forum list", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "super-mod");
      await view.navigate(FORUM_URL);
      await waitForSelector(view, "[data-bulk-topics]", 20_000);
      await waitForSelector(view, 'html[data-moderation-tools-ready="true"]', 20_000);
      await waitForSelector(view, "[data-bulk-topic-check]", 20_000);
      const ids = await view.evaluate<string[]>(
        `[...document.querySelectorAll('[data-bulk-topic-check]')].slice(0, 2).map((element) => element.getAttribute("data-bulk-topic-check") ?? "")`,
      );

      if (ids.length < 2) {
        throw new Error("Need two topics for the bulk action");
      }

      for (const id of ids) {
        await clickSelector(view, `[data-bulk-topic-check="${id}"]`);
      }

      await waitForSelector(view, '[data-bulk-topic-action="lock"]', 20_000);
      await clickSelector(view, '[data-bulk-topic-action="lock"]');
      await waitForExpression(
        view,
        `${JSON.stringify(ids)}.every((id) =>
          document.querySelector('[data-topic-row="' + id + '"] [data-topic-locked]') !== null
        )`,
        20_000,
      );
      await waitForSelector(view, 'html[data-moderation-tools-ready="true"]', 20_000);
      expect(
        await view.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBeLessThanOrEqual(1);

      // Leave the shared seeded forum as we found it for the rest of the suite. Chrome may
      // restore the old checkbox state after the reload, so set it explicitly.
      await view.evaluate(`(() => {
        for (const id of ${JSON.stringify(ids)}) {
          const input = document.querySelector('[data-bulk-topic-check="' + id + '"]');
          if (input instanceof HTMLInputElement) input.checked = true;
        }
        return true;
      })()`);

      await clickSelector(view, '[data-bulk-topic-action="unlock"]');
      await waitForExpression(
        view,
        `${JSON.stringify(ids)}.every((id) =>
          document.querySelector('[data-topic-row="' + id + '"] [data-topic-locked]') === null
        )`,
        20_000,
      );
    });
  }, 120_000);
});
