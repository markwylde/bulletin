import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loginAs, waitForExpression, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";
import { restorePmDailyStarts, setPmDailyStarts } from "./support/group-settings.ts";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const ORIGIN = new URL(USER_URL).origin;

async function createConversation(view: Bun.WebView, title: string): Promise<string> {
  const result = await view.evaluate<string>(`(async () => {
    const session = await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    }).then((response) => response.json());
    const suggest = await fetch(
      "/api/members/suggest?q=" + encodeURIComponent("Regular Member Two"),
      { headers: { accept: "application/json" } },
    ).then((response) => response.json());
    const member = suggest.members?.[0];
    if (!member) return "missing-member";
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        title: ${JSON.stringify(title)},
        bodyMd: "First live message.",
        recipientIds: [member.id],
      }),
    });
    if (!response.ok) return "status-" + response.status;
    return (await response.json()).conversationId;
  })()`);

  if (!/^[1-9]\d*$/.test(result)) {
    throw new Error(`Could not create the conversation: ${result}`);
  }

  return result;
}

/** Mint a member-2 session over the development-only test endpoint. */
async function replyAsMemberTwo(conversationId: string, body: string): Promise<void> {
  const minted = await fetch(`${USER_URL}/api/test/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ sub: "member-2" }),
  });

  if (!minted.ok) {
    throw new Error(`Could not mint the session: ${minted.status}`);
  }

  const cookie = (minted.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";

  if (cookie === "") {
    throw new Error("The test session returned no cookie");
  }

  const session = (await fetch(`${USER_URL}/api/auth/session`, {
    headers: { accept: "application/json", cookie },
  }).then((response) => response.json())) as { csrfToken?: string | null };
  const response = await fetch(`${USER_URL}/api/conversations/${conversationId}/replies`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      cookie,
      "x-bulletin-csrf": session.csrfToken ?? "",
    },
    body: JSON.stringify({ bodyMd: body }),
  });

  if (!response.ok) {
    throw new Error(`Reply failed: ${response.status} ${await response.text()}`);
  }
}

integrationDescribe("live conversation replies", () => {
  // The member's daily start limit is shared with earlier runs of the suite.
  beforeAll(async () => {
    await setPmDailyStarts(0);
  }, 120_000);
  afterAll(async () => {
    await restorePmDailyStarts();
  }, 120_000);

  test("a reply appears in the open conversation without a reload", async () => {
    const title = `Live conversation ${Date.now()}`;
    const replyText = `Live reply ${Date.now()}`;

    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        const conversationId = await createConversation(view, title);
        await view.navigate(new URL(`/conversations/${conversationId}`, USER_URL).toString());
        await waitForSelector(
          view,
          '[data-conversation-page][data-conversation-ready="true"]',
          20_000,
        );
        await waitForExpression(view, 'document.documentElement.dataset.stream === "open"', 20_000);
        const urlBefore = await view.evaluate<string>("window.location.href");
        const messagesBefore = await view.evaluate<number>(
          'document.querySelectorAll("[data-conversation-message]").length',
        );
        const sentinel = `sentinel-${Date.now()}`;
        await view.evaluate(`window.__bulletinConversationSentinel = ${JSON.stringify(sentinel)}`);

        await replyAsMemberTwo(conversationId, replyText);

        await waitForExpression(
          view,
          `document.body.innerText.includes(${JSON.stringify(replyText)})`,
          20_000,
        );
        expect(await view.evaluate<string>("window.location.href")).toBe(urlBefore);
        expect(
          await view.evaluate<number>(
            'document.querySelectorAll("[data-conversation-message]").length',
          ),
        ).toBe(messagesBefore + 1);
      },
    );
  }, 240_000);
});
