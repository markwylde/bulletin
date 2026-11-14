import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { restorePmDailyStarts, setPmDailyStarts } from "./support/group-settings.ts";

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

/**
 * Sends a reply and waits for it to render. The composer reloads the page itself; if that
 * reload races a slow connection, re-open the conversation once rather than timing out.
 */
async function sendReply(view: Bun.WebView, conversationId: string, body: string): Promise<void> {
  await openReplyEditor(view);
  await setInputValue(view, "[data-conversation-reply-form] [data-editor-source]", body);
  await waitForSelector(view, "[data-reply-submit]:not([disabled])", 20_000);
  await clickSelector(view, "[data-reply-submit]:not([disabled])");
  const rendered = `[...document.querySelectorAll("[data-conversation-message]")].some(
    (message) => message.textContent?.includes(${JSON.stringify(body)}) === true
  )`;

  try {
    await waitForExpression(view, rendered, 10_000);
    return;
  } catch {
    // The reply may already be committed; reading it again is idempotent.
  }

  await view.navigate(new URL(`/conversations/${conversationId}`, USER_URL).toString());
  await waitForSelector(view, '[data-conversation-page][data-conversation-ready="true"]', 20_000);
  await waitForExpression(view, rendered, 20_000);
}

integrationDescribe("conversation inbox and folders", () => {
  // Earlier runs count against the member's daily start limit; this journey starts a new
  // conversation once per viewport, so lift the limit for the file and restore it after.
  beforeAll(async () => {
    await setPmDailyStarts(0);
  }, 120_000);
  afterAll(async () => {
    await restorePmDailyStarts();
  }, 120_000);

  for (const viewport of VIEWPORTS) {
    test(`archives, replies and tracks unread at ${viewport}`, async () => {
      const title = `E2E conversation ${viewport} ${Date.now()}`;
      const replyBody = `Reply from member two ${Date.now()}.`;
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
          await sendReply(view, conversationId, replyBody);
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
          // Leave only once the read marker is saved; navigating sooner races it.
          await waitForSelector(
            view,
            '[data-conversation-page][data-conversation-ready="true"][data-conversation-read="true"]',
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

integrationDescribe("conversation leave controls", () => {
  test("clicking the leave section checkbox or heading never leaves", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        await view.navigate(new URL("/conversations", USER_URL).toString());
        await waitForSelector(view, '[data-conversations-page][data-conversations-ready="true"]');

        const href = await view.evaluate<string | null>(`(() => {
          const link = [...document.querySelectorAll("[data-conversation-link]")].find(
            (element) => element.textContent?.includes("Weekend plans")
          );
          return link?.getAttribute("href") ?? null;
        })()`);

        if (href === null) {
          throw new Error("Missing the seeded Weekend plans conversation");
        }

        await view.navigate(new URL(href, USER_URL).toString());
        await waitForSelector(view, '[data-conversation-page][data-conversation-ready="true"]');
        const before = await view.evaluate<string>("window.location.href");

        await clickSelector(view, "[data-leave-block]");
        await clickSelector(view, "[data-conversation-leave] h2");
        await clickSelector(view, "[data-conversation-leave] label");
        await Bun.sleep(300);

        expect(await view.evaluate<string>("window.location.href")).toBe(before);
        await waitForSelector(view, "[data-conversation-page]");
      },
    );
  }, 120_000);
});

integrationDescribe("conversation error feedback", () => {
  test("shows the numeric recipient limit when too many members are added", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [
          /ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/,
          /400.*\/api\/conversations/,
        ],
      },
      async (view) => {
        await loginAs(view, "member-1");
        await view.navigate(new URL("/conversations", USER_URL).toString());
        await waitForSelector(view, '[data-conversations-page][data-conversations-ready="true"]');
        await clickSelector(view, "[data-new-conversation] summary");
        await waitForSelector(view, "[data-new-conversation-form]");
        await view.evaluate(
          `document.querySelector('[data-new-conversation-form] bl-island[data-name="Editor"]')?.scrollIntoView({ block: "center" })`,
        );
        await waitForSelector(view, '[data-new-conversation-form] [data-editor-ready="true"]');
        await clickSelector(view, "[data-editor-mode=source]");
        await waitForSelector(view, "[data-new-conversation-form] [data-editor-source]");

        for (const [index, name] of ["Regular Member Two", "Miembro Español"].entries()) {
          await setInputValue(view, "#new-conversation-recipient", name);
          await waitForExpression(
            view,
            `[...document.querySelectorAll("[data-recipient-results] [data-suggest-id]")].some(
              (element) => element.textContent?.includes(${JSON.stringify(name)}) === true
            )`,
            20_000,
          );
          await view.evaluate(`(() => {
            const button = [...document.querySelectorAll("[data-recipient-results] [data-suggest-id]")].find(
              (element) => element.textContent?.includes(${JSON.stringify(name)}) === true
            );
            button?.click();
          })()`);
          await waitForExpression(
            view,
            `document.querySelectorAll("[data-recipient-selected] [data-recipient-selected]").length === ${index + 1}`,
            20_000,
          );
        }

        await setInputValue(view, "#conversation-title", `Recipient limit ${Date.now()}`);
        await setInputValue(
          view,
          "[data-new-conversation-form] [data-editor-source]",
          "This should be refused.",
        );
        await waitForSelector(view, "[data-new-conversation-submit]:not([disabled])");
        await clickSelector(view, "[data-new-conversation-submit]:not([disabled])");
        await waitForSelector(view, "[data-form-error]:not([hidden])", 20_000);

        const error = await view.evaluate<string>(
          'document.querySelector("[data-new-conversation-form] [data-form-error]")?.textContent ?? ""',
        );
        expect(error).toContain("1");
        expect(await view.evaluate<string>("window.location.pathname")).toBe("/conversations");
      },
    );
  }, 180_000);
});
