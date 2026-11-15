import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  VIEWPORTS,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const REPORTS_URL = new URL("/moderation/reports", USER_URL).toString();

for (const viewportName of ["mobile360", "desktop"] as ViewportName[]) {
  integrationDescribe(`report centre at ${viewportName}`, () => {
    test("a member reports a post and a moderator resolves it", async () => {
      const viewport = VIEWPORTS[viewportName];
      const comment = `E2E report ${viewportName} ${Date.now()}`;

      await withPage({ url: USER_URL, viewport }, async (view) => {
        await loginAs(view, "member-1");
        await view.navigate(new URL("/forum/5-off-topic", USER_URL).toString());
        await waitForSelector(view, "[data-topic-list] [data-topic-link]", 20_000);
        const href = await view.evaluate<string | null>(
          'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
        );

        if (href === null) {
          throw new Error("Missing a topic");
        }

        await view.navigate(new URL(href, USER_URL).toString());
        await waitForSelector(view, "[data-post]", 20_000);
        await waitForSelector(view, "[data-report-post]:not([hidden])", 20_000);
        await clickSelector(view, "[data-report-post]");
        await waitForSelector(view, "dialog[open]", 20_000);
        await setInputValue(view, "dialog.bl-report-dialog select", "spam");
        await setInputValue(view, "dialog.bl-report-dialog textarea", comment);
        await clickSelector(view, 'dialog.bl-report-dialog button[type="submit"]');
        await waitForExpression(
          view,
          `document.querySelector('dialog.bl-report-dialog .bl-note')?.textContent?.trim().length > 0`,
          20_000,
        );
      });

      await withPage({ url: USER_URL, viewport }, async (view) => {
        await loginAs(view, "super-mod");
        await view.navigate(REPORTS_URL);
        await waitForSelector(view, "[data-reports-page]", 20_000);
        await waitForExpression(
          view,
          `[...document.querySelectorAll('[data-report-list] li')].some(
            (element) => element.textContent?.includes(${JSON.stringify(comment)})
          )`,
          20_000,
        );
        const reportId = await view.evaluate<string | null>(`(() => {
          const item = [...document.querySelectorAll('[data-report-list] li')].find(
            (element) => element.textContent?.includes(${JSON.stringify(comment)})
          );
          return item?.getAttribute("data-report-id") ?? null;
        })()`);

        if (reportId === null) {
          throw new Error("Missing the new report");
        }

        await view.navigate(new URL(`/moderation/reports/${reportId}`, USER_URL).toString());
        // The status controls only work once the page script has attached its handlers.
        await waitForSelector(view, '[data-report-page][data-report-ready="true"]', 20_000);
        await waitForSelector(view, "[data-report-status-select]", 20_000);
        await setInputValue(view, "[data-report-status-select]", "resolved");
        await waitForSelector(view, "[data-report-status-save]:not([disabled])", 20_000);
        await clickSelector(view, "[data-report-status-save]");
        await waitForExpression(
          view,
          `document.querySelector('[data-report-status-label]')?.textContent?.includes('Resolved') === true`,
          20_000,
        );
        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);
      });
    }, 180_000);
  });
}

integrationDescribe("report centre permission denial", () => {
  test("a member without report access sees the forbidden page", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/moderation\/reports/],
      },
      async (view) => {
        await loginAs(view, "member-2");
        await view.navigate(REPORTS_URL);
        await waitForSelector(view, '[data-error-code="forbidden"]', 20_000);
        expect(await view.evaluate<string>("document.body.innerText")).not.toContain("Reporters");
      },
    );
  }, 120_000);
});
