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
const POLL_TITLE = "Poll: what should we read next?";

/** Finds the seeded poll topic even after earlier runs pushed it onto a later page. */
async function findPollHref(view: Bun.WebView): Promise<string> {
  for (let page = 0; page < 20; page += 1) {
    await waitForSelector(view, "[data-topic-list]", 20_000);
    const href = await view.evaluate<string | null>(
      `(() => {
        const link = [...document.querySelectorAll('[data-topic-list] [data-topic-link]')].find(
          (element) => element.textContent?.includes(${JSON.stringify(POLL_TITLE)})
        );
        return link?.getAttribute('href') ?? null;
      })()`,
    );

    if (href !== null) {
      return href;
    }

    const next = await view.evaluate<string | null>(
      'document.querySelector("[data-page-next]")?.getAttribute("href") ?? null',
    );

    if (next === null) {
      break;
    }

    await view.navigate(new URL(next, USER_URL).toString());
  }

  throw new Error("Missing the seeded poll topic");
}

integrationDescribe("poll voting", () => {
  test("votes in a hidden-results poll at 360 px", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.evaluate('fetch("/api/test/reset-poll-votes", { method: "POST" })');
      await view.navigate(FORUM_URL);
      const href = await findPollHref(view);

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

  test("shows the choices to guests but disables voting", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await view.navigate(FORUM_URL);
      const href = await findPollHref(view);
      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, '[data-poll-form][data-poll-guest="true"]', 20_000);

      const ballot = await view.evaluate<{
        readonly choices: readonly string[];
        readonly inputsDisabled: boolean;
        readonly submitDisabled: boolean;
        readonly resultsHidden: boolean;
        readonly questions: number;
        readonly formVisible: boolean;
      }>(`(() => {
        const form = document.querySelector('[data-poll-form]');
        const questions = [...document.querySelectorAll('[data-poll-question]')];
        const inputs = [...document.querySelectorAll('input[data-poll-choice]')];
        return {
          choices: inputs.map((input) => input.parentElement?.textContent?.trim() ?? ''),
          inputsDisabled: inputs.length > 0 && inputs.every((input) => input.disabled),
          submitDisabled:
            document.querySelector('[data-poll-submit]')?.disabled === true,
          resultsHidden:
            document.querySelector('[data-poll-results]')?.hasAttribute('hidden') === true,
          questions: questions.length,
          formVisible: form !== null && !form.hidden,
        };
      })()`);

      expect(ballot.choices.length).toBeGreaterThan(0);
      expect(ballot.choices.join(" ")).toContain("A novel");
      expect(ballot.questions).toBeGreaterThan(0);
      expect(ballot.formVisible).toBe(true);
      expect(ballot.inputsDisabled).toBe(true);
      expect(ballot.submitDisabled).toBe(true);
      expect(ballot.resultsHidden).toBe(true);
      expect(
        await view.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBeLessThanOrEqual(1);
    });
  }, 120_000);
});
