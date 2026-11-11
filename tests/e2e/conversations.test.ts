import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d --build --wait
//   BULLETIN_E2E=1 bun test tests/e2e/conversations.test.ts

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

async function withinWidth(view: Bun.WebView): Promise<boolean> {
  return view.evaluate<boolean>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
  );
}

/** Starts a conversation through the real form, exercising the recipient picker and editor. */
async function startConversationThroughUi(
  view: Bun.WebView,
  input: { readonly title: string; readonly body: string; readonly recipient: string },
): Promise<string> {
  await view.navigate(new URL("/conversations", USER_URL).toString());
  await waitForSelector(view, '[data-conversations-page][data-conversations-ready="true"]', 20_000);
  await clickSelector(view, "[data-new-conversation] summary");
  await waitForSelector(view, "[data-new-conversation-form]", 20_000);
  await view.evaluate(
    `document.querySelector('[data-new-conversation-form] bl-island[data-name="Editor"]')?.scrollIntoView({ block: "center" })`,
  );
  await waitForSelector(view, '[data-new-conversation-form] [data-editor-ready="true"]', 20_000);
  await waitForSelector(view, "[data-editor-mode=source]", 20_000);
  await clickSelector(view, "[data-editor-mode=source]");
  await waitForSelector(view, "[data-new-conversation-form] [data-editor-source]", 20_000);

  await setInputValue(view, "#conversation-title", input.title);
  await setInputValue(view, "#new-conversation-recipient", input.recipient);
  await waitForSelector(view, "[data-recipient-results] [data-suggest-id]:not([disabled])", 20_000);
  await clickSelector(view, "[data-recipient-results] [data-suggest-id]:not([disabled])");
  await waitForSelector(view, "[data-recipient-selected] [data-recipient-selected]", 20_000);
  await setInputValue(view, "[data-new-conversation-form] [data-editor-source]", input.body);
  await waitForSelector(view, "[data-new-conversation-submit]:not([disabled])", 20_000);
  await clickSelector(view, "[data-new-conversation-submit]:not([disabled])");
  await waitForSelector(view, '[data-conversation-page][data-conversation-ready="true"]', 20_000);

  const conversationId = await view.evaluate<string>(
    `document.querySelector('[data-conversation-page][data-conversation-ready="true"]')?.getAttribute("data-conversation-id") ?? ""`,
  );

  if (!/^[1-9]\d*$/.test(conversationId)) {
    throw new Error("The new conversation did not render its page");
  }

  return conversationId;
}

async function openReplyEditor(view: Bun.WebView): Promise<void> {
  await waitForSelector(view, "[data-conversation-reply-form]", 20_000);
  await view.evaluate(
    `document.querySelector('[data-conversation-reply-form] bl-island[data-name="Editor"]')?.scrollIntoView({ block: "center" })`,
  );
  await waitForSelector(view, '[data-conversation-reply-form] [data-editor-ready="true"]', 20_000);
  await waitForSelector(view, "[data-editor-mode=source]", 20_000);
  await clickSelector(view, "[data-editor-mode=source]");
  await waitForSelector(view, "[data-conversation-reply-form] [data-editor-source]", 20_000);
}

integrationDescribe("conversation inbox and folders", () => {
  for (const viewport of VIEWPORTS) {
    test(`archives, replies and tracks unread at ${viewport}`, async () => {
      const title = `E2E conversation ${viewport} ${Date.now()}`;
      let conversationId = "";

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          conversationId = await startConversationThroughUi(view, {
            title,
            body: "First message from member one.",
            recipient: "Regular Member Two",
          });

          await view.navigate(new URL("/conversations", USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversations-page][data-conversations-ready="true"]',
            20_000,
          );
          await waitForSelector(view, `[data-conversation-row="${conversationId}"]`, 20_000);
          expect(await withinWidth(view)).toBe(true);

          await view.navigate(new URL(`/conversations/${conversationId}`, USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversation-page][data-conversation-ready="true"]',
            20_000,
          );
          await waitForExpression(
            view,
            `document.body.innerText.includes(${JSON.stringify(title)})`,
            20_000,
          );
          await waitForSelector(view, "[data-conversation-archive]:not([disabled])", 20_000);
          await clickSelector(view, "[data-conversation-archive]:not([disabled])");

          await waitForSelector(
            view,
            '[data-conversations-page][data-conversations-ready="true"]',
            20_000,
          );
          await waitForSelector(view, `[data-conversation-row="${conversationId}"]`, 20_000);
          expect(
            await view.evaluate<string>(
              'document.querySelector(\'[data-conversation-folder="archive"]\')?.getAttribute("href") ?? ""',
            ),
          ).toContain("folder=archive");
        },
      );

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-2");
          await view.navigate(new URL("/conversations", USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversations-page][data-conversations-ready="true"]',
            20_000,
          );
          await waitForSelector(view, `[data-conversation-row="${conversationId}"]`, 20_000);
          expect(
            await view.evaluate<boolean>(
              `document.querySelector('[data-conversation-row="${conversationId}"] [data-conversation-unread]') !== null`,
            ),
          ).toBe(true);

          await view.navigate(new URL(`/conversations/${conversationId}`, USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversation-page][data-conversation-ready="true"]',
            20_000,
          );
          await openReplyEditor(view);
          await setInputValue(
            view,
            "[data-conversation-reply-form] [data-editor-source]",
            "Reply from member two.",
          );
          await waitForSelector(view, "[data-reply-submit]:not([disabled])", 20_000);
          await clickSelector(view, "[data-reply-submit]:not([disabled])");
          await waitForExpression(
            view,
            `document.body.innerText.includes("Reply from member two.")`,
            20_000,
          );
        },
      );

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await view.navigate(new URL("/conversations", USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversations-page][data-conversations-ready="true"]',
            20_000,
          );
          await waitForSelector(view, `[data-conversation-row="${conversationId}"]`, 20_000);
          expect(
            await view.evaluate<boolean>(
              `document.querySelector('[data-conversation-row="${conversationId}"] [data-conversation-unread]') !== null`,
            ),
          ).toBe(true);
          expect(await withinWidth(view)).toBe(true);

          await view.navigate(new URL(`/conversations/${conversationId}`, USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversation-page][data-conversation-ready="true"]',
            20_000,
          );
          await view.navigate(new URL("/conversations", USER_URL).toString());
          await waitForSelector(
            view,
            '[data-conversations-page][data-conversations-ready="true"]',
            20_000,
          );
          await waitForExpression(
            view,
            `document.querySelector('[data-conversation-row="${conversationId}"] [data-conversation-unread]') === null`,
            20_000,
          );
        },
      );
    }, 300_000);
  }
});
