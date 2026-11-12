import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();

integrationDescribe("warnings at mobile360", () => {
  test("an admin defines a reason, a moderator warns and the member acknowledges", async () => {
    const stamp = Date.now();
    const reasonName = `E2E warning ${stamp}`;

    await withPage(
      { url: `${STAFF_URL}/moderation/warnings`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="warnings"]', 20_000);
        await waitForSelector(view, "[data-warning-reason-key]", 20_000);
        await setInputValue(view, "[data-warning-reason-key]", `e2e_${stamp}`);
        await setInputValue(view, "[data-warning-reason-en]", reasonName);
        await setInputValue(view, "[data-warning-reason-points]", "2");
        await setInputValue(view, "[data-warning-reason-expiry]", "7");
        await clickSelector(view, "[data-warning-reason-save]");
        await waitForExpression(
          view,
          `[...document.querySelectorAll('[data-warning-reason]')].some(
          (element) => element.textContent?.includes(${JSON.stringify(reasonName)})
        )`,
          20_000,
        );
      },
    );

    let memberId = "";

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "super-mod");
      await view.navigate(FORUM_URL);
      await waitForSelector(view, "[data-topic-list] [data-topic-link]", 20_000);
      const href = await view.evaluate<string | null>(
        'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
      );

      if (href === null) {
        throw new Error("Missing a topic");
      }

      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, "[data-post]", 20_000);
      await waitForSelector(view, "[data-warn-post]", 20_000);
      await clickSelector(view, "[data-warn-post]");
      await waitForSelector(view, '[data-staff-warnings-page][data-warnings-ready="true"]', 20_000);
      memberId = await view.evaluate<string>(
        'document.querySelector("[data-staff-warnings-page]")?.getAttribute("data-member-id") ?? ""',
      );

      const selected = await view.evaluate<boolean>(`(() => {
        const select = document.querySelector('[data-warning-reason]');
        if (!(select instanceof HTMLSelectElement)) return false;
        const option = [...select.options].find(
          (item) => item.textContent?.includes(${JSON.stringify(reasonName)})
        );
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`);

      if (!selected) {
        throw new Error("Missing the new warning reason");
      }

      await setInputValue(view, "[data-warning-member-note]", "Please read the rules.");
      await clickSelector(view, "[data-warning-ack-required]");
      await waitForSelector(view, "[data-warning-issue-submit]:not([disabled])", 20_000);
      await clickSelector(view, "[data-warning-issue-submit]");
      await waitForSelector(view, "[data-warning-id]", 20_000);
    });

    expect(memberId).toMatch(/^\d+$/);

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "new-member");
      await view.navigate(new URL("/account/warnings", USER_URL).toString());
      await waitForSelector(view, '[data-warnings-page][data-warnings-ready="true"]', 20_000);
      await waitForExpression(
        view,
        `document.body.textContent?.includes(${JSON.stringify(reasonName)}) === true &&
          document.body.textContent?.includes("Please read the rules.") === true`,
        20_000,
      );
      await waitForSelector(view, "[data-warning-ack-button]", 20_000);
      await clickSelector(view, "[data-warning-ack-button]");
      await waitForExpression(
        view,
        "document.querySelector('[data-warning-ack-button]') === null",
        20_000,
      );
      expect(
        await view.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBeLessThanOrEqual(1);
    });

    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/moderation\/warnings/],
      },
      async (view) => {
        await loginAs(view, "member-2");
        await view.navigate(new URL(`/moderation/warnings/${memberId}`, USER_URL).toString());
        await waitForSelector(view, '[data-error-code="forbidden"]', 20_000);
      },
    );
  }, 240_000);
});
