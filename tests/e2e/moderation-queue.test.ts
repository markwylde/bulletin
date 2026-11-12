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
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const QUEUE_URL = new URL("/moderation/queue", USER_URL).toString();

async function setForumApproval(view: Bun.WebView, enabled: boolean): Promise<void> {
  await view.navigate(`${STAFF_URL}/forums`);
  await waitForSelector(view, '[data-page="forums"]');
  await waitForSelector(view, '[data-forum-title="Off Topic"] [data-forum-settings]', 20_000);
  await clickSelector(view, '[data-forum-title="Off Topic"] [data-forum-settings]');
  await waitForSelector(view, '[data-forum-setting="require-approval-posts"]', 20_000);

  const changed = await view.evaluate<boolean>(`(() => {
    const input = document.querySelector('[data-forum-setting="require-approval-posts"]');
    if (!(input instanceof HTMLInputElement)) return false;
    if (input.checked !== ${enabled}) input.click();
    return true;
  })()`);

  if (!changed) {
    throw new Error("Forum approval toggle not found");
  }

  await waitForExpression(
    view,
    `document.querySelector('[data-forum-setting="require-approval-posts"]')?.checked === ${enabled}`,
    5_000,
  );
  await waitForSelector(view, "[data-forum-settings-save]:not([disabled])", 20_000);
  await clickSelector(view, "[data-forum-settings-save]");
  await waitForSelector(view, '[data-toast-tone="success"]');
}

async function openFirstTopic(view: Bun.WebView): Promise<string> {
  await view.navigate(FORUM_URL);
  await waitForSelector(view, "[data-topic-list] [data-topic-link]", 20_000);
  const href = await view.evaluate<string | null>(
    'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
  );

  if (href === null) {
    throw new Error("Missing a topic to reply to");
  }

  const url = new URL(href, USER_URL).toString();
  await view.navigate(url);
  await waitForSelector(view, "[data-topic-page]", 20_000);
  return url;
}

async function replyHeld(view: Bun.WebView, body: string): Promise<void> {
  await clickSelector(view, "[data-reply-toggle]");
  await waitForSelector(view, "[data-reply-form]:not([hidden])", 20_000);
  await view.evaluate(
    `document.querySelector('[data-reply-form] bl-island[data-name="Editor"]')?.scrollIntoView({ block: "center" })`,
  );
  await waitForSelector(view, '[data-reply-form] [data-editor-ready="true"]', 20_000);
  await waitForSelector(view, '[data-editor-mode="source"]', 20_000);
  await clickSelector(view, '[data-editor-mode="source"]');
  await waitForSelector(view, "[data-reply-form] [data-editor-source]", 20_000);
  await setInputValue(view, "[data-reply-form] [data-editor-source]", body);
  await waitForSelector(view, "[data-reply-submit]:not([disabled])", 20_000);
  await clickSelector(view, "[data-reply-submit]");
  await waitForSelector(view, "[data-topic-page]", 20_000);
  // The held block arrives through the personal overlay (covered by integration tests); a
  // slow overlay must not hide the queue journey this E2E is exercising.
  await Bun.sleep(750);
}

for (const viewportName of ["mobile360", "desktop"] as ViewportName[]) {
  integrationDescribe(`moderation queue at ${viewportName}`, () => {
    test("holds replies, counts them live and bulk approves and rejects in both apps", async () => {
      const viewport = VIEWPORTS[viewportName];
      const stamp = Date.now();
      const firstBody = `Held reply from ${viewportName} ${stamp}`;
      const secondBody = `Rejected reply from ${viewportName} ${stamp}`;
      let topicUrl = FORUM_URL;

      try {
        await withPage({ url: `${STAFF_URL}/forums`, viewport }, async (view) => {
          await loginAs(view, "admin");
          await setForumApproval(view, true);
        });

        await withPage({ url: USER_URL, viewport }, async (view) => {
          await loginAs(view, "member-1");
          await view.evaluate('fetch("/api/test/reset-rate-buckets", { method: "POST" })');
          topicUrl = await openFirstTopic(view);
          await replyHeld(view, firstBody);
        });

        await withPage({ url: QUEUE_URL, viewport }, async (view) => {
          await loginAs(view, "super-mod");
          await view.navigate(QUEUE_URL);
          await waitForSelector(
            view,
            '[data-moderation-queue][data-moderation-ready="true"]',
            20_000,
          );
          await waitForExpression(
            view,
            `Number(document.querySelector('[data-moderation-count]')?.textContent ?? '0') >= 1`,
            5_000,
          );
          await waitForSelector(view, "[data-moderation-item]", 20_000);
          await clickSelector(view, "[data-moderation-select-all]");
          await waitForSelector(view, "[data-moderation-approve]:not([disabled])", 20_000);
          await clickSelector(view, "[data-moderation-approve]");
          await waitForSelector(view, "[data-moderation-status]:not([hidden])", 20_000);
          await waitForExpression(
            view,
            `document.querySelector('[data-moderation-count]')?.textContent?.trim() === '0'`,
            5_000,
          );
          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        });

        await withPage({ url: USER_URL, viewport }, async (view) => {
          await loginAs(view, "member-1");
          await view.evaluate('fetch("/api/test/reset-rate-buckets", { method: "POST" })');
          await view.navigate(topicUrl);
          await waitForSelector(view, "[data-post-list]", 20_000);
          await waitForExpression(
            view,
            `document.querySelector('[data-post-held]') === null &&
              [...document.querySelectorAll('[data-post-body]')].some(
                (element) => element.textContent?.includes(${JSON.stringify(firstBody)})
              )`,
            20_000,
          );
          await replyHeld(view, secondBody);
        });

        await withPage({ url: `${STAFF_URL}/moderation`, viewport }, async (view) => {
          await loginAs(view, "admin");
          await waitForSelector(view, '[data-page="moderation"]', 20_000);
          await waitForSelector(view, "[data-moderation-item]", 20_000);
          await clickSelector(view, "[data-moderation-check]");
          await waitForSelector(view, "[data-moderation-reject]:not([disabled])", 20_000);
          await clickSelector(view, "[data-moderation-reject]");
          await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
          await waitForExpression(
            view,
            `document.querySelectorAll('[data-moderation-item]').length === 0`,
            20_000,
          );
          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        });
      } finally {
        await withPage({ url: `${STAFF_URL}/forums`, viewport }, async (view) => {
          await loginAs(view, "admin");
          await setForumApproval(view, false);
        }).catch(() => undefined);
      }
    }, 300_000);
  });
}

integrationDescribe("moderation queue permission denial", () => {
  test("a member without approve power sees the forbidden page", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/moderation\/queue/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        await view.navigate(QUEUE_URL);
        await waitForSelector(view, '[data-error-code="forbidden"]', 20_000);
        const text = await view.evaluate<string>("document.body.innerText");
        expect(text).not.toContain("Approve selected");
      },
    );
  }, 120_000);
});
