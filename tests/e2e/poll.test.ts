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

integrationDescribe("poll voting", () => {
  test("votes in a hidden-results poll at 360 px", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.evaluate('fetch("/api/test/reset-poll-votes", { method: "POST" })');
      await view.navigate(FORUM_URL);
      await waitForSelector(view, "[data-topic-list]", 20_000);

      const href = await view.evaluate<string | null>(`(() => {
        const link = [...document.querySelectorAll('[data-topic-list] [data-topic-link]')].find(
          (element) => element.textContent?.includes('Poll: what should we read next?')
        );
        return link?.getAttribute('href') ?? null;
      })()`);

      if (href === null) {
        throw new Error("Missing the seeded poll topic");
      }

      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, "[data-poll-form]", 20_000);
      await waitForSelector(view, "[data-poll-submit]:not([disabled])", 20_000);

      const chose = await view.evaluate<boolean>(`(() => {
        const questions = [...document.querySelectorAll('[data-poll-question]')];
        if (questions.length === 0) return false;
        for (const question of questions) {
          const input = question.querySelector('input[data-poll-choice]');
          if (!(input instanceof HTMLInputElement)) return false;
          input.click();
        }
        return true;
      })()`);
      expect(chose).toBe(true);

      await clickSelector(view, "[data-poll-submit]");
      await waitForSelector(view, "[data-poll-results]:not([hidden])", 20_000);
      await waitForExpression(
        view,
        `[...document.querySelectorAll('[data-poll-results] [data-poll-count]')].some(
          (element) => Number(element.textContent ?? "0") > 0
        )`,
        20_000,
      );

      expect(
        await view.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBeLessThanOrEqual(1);
    });
  }, 120_000);
});
