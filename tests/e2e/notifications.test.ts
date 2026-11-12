import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const NOTIFICATIONS_URL = new URL("/account/notifications", USER_URL).toString();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "mobile390", "desktop"];

interface TopicTarget {
  readonly id: string;
  readonly url: string;
}

/** Opens the first topic in Off Topic as member-1 and makes sure they follow it. */
async function followedTopic(): Promise<TopicTarget> {
  let target: TopicTarget | null = null;

  await withPage({ url: USER_URL, viewport: "desktop" }, async (view) => {
    await loginAs(view, "member-1");
    await view.navigate(FORUM_URL);
    await waitForSelector(view, "[data-topic-list] [data-topic-link]");

    const href = await view.evaluate<string | null>(
      'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
    );

    if (href === null) {
      throw new Error("Missing topic link");
    }

    await view.navigate(new URL(href, USER_URL).toString());
    await waitForSelector(view, "[data-topic-page]");

    const id = await view.evaluate<string>(
      'document.querySelector("[data-topic-page]")?.getAttribute("data-topic-id") ?? ""',
    );
    expect(id).toMatch(/^\d+$/);

    await waitForExpression(
      view,
      `document.querySelector('[data-follow-context="topic:${id}"]')?.getAttribute("data-following") !== null`,
      20_000,
    );

    if (
      (await view.evaluate<string | null>(
        `document.querySelector('[data-follow-context="topic:${id}"]')?.getAttribute("data-following")`,
      )) !== "true"
    ) {
      const follow = `[data-follow-context="topic:${id}"] [data-follow-action="follow"]:not([disabled])`;
      await waitForSelector(view, follow);
      await clickSelector(view, follow);
      await waitForExpression(
        view,
        `document.querySelector('[data-follow-context="topic:${id}"]')?.getAttribute("data-following") === "true"`,
        20_000,
      );
    }

    target = { id, url: new URL(href, USER_URL).toString() };
  });

  if (target === null) {
    throw new Error("Could not prepare a followed topic");
  }

  return target;
}

// Each reply comes from a different member: flood control is per member and the whole file
// replies several times in a row. Members that moderation E2E tests warn, suspend or ban
// (new-member, warned-member) are deliberately absent: the guards still apply to them.
const REPLIERS = [
  "member-2",
  "member-fr",
  "member-es",
  "forum-mod",
  "member-mod",
  "account-member",
];
let replyIndex = 0;

/** A fresh member replies through the API so the reply does not need the editor island. */
async function replyToTopic(topicId: string): Promise<void> {
  const profile = REPLIERS[replyIndex % REPLIERS.length] ?? "member-2";
  replyIndex += 1;

  await withPage(
    {
      url: USER_URL,
      viewport: "desktop",
      // A flood-limited retry is expected after repeated runs; it is retried below.
      allowConsoleErrors: [
        /429.*\/api\/topics\/\d+\/replies/,
        /ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/,
      ],
    },
    async (view) => {
      await loginAs(view, profile);
      await waitForSelector(view, '[data-auth-state="authenticated"]');

      const result = await view.evaluate<{
        status: number;
        retryAfterSeconds?: number;
      }>(`(async () => {
      let token = null;
      try { token = sessionStorage.getItem("bulletin_csrf_token"); } catch {}
      if (token === null) {
        const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } });
        token = (await session.json()).csrfToken ?? null;
      }
      const response = await fetch("/api/topics/${topicId}/replies", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bulletin-csrf": token ?? "" },
        body: JSON.stringify({ bodyMd: "A browser notification reply." })
      });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, retryAfterSeconds: payload.retryAfterSeconds ?? 0 };
    })()`);

      if (result.status === 429 && result.retryAfterSeconds !== undefined) {
        await Bun.sleep((result.retryAfterSeconds + 1) * 1_000);
        await replyToTopic(topicId);
        return;
      }

      expect(result.status).toBe(200);
    },
  );
}

/** The bell count is applied by a one-shot overlay; reload once if the first load raced it. */
async function waitForBellCount(view: Bun.WebView): Promise<void> {
  const selector = '[data-overlay-count="notifications"]:not([hidden])';

  try {
    await waitForSelector(view, selector, 8_000);
    return;
  } catch {
    await view.navigate(NOTIFICATIONS_URL);
    await waitForSelector(view, "[data-notifications-page]");
    await waitForSelector(view, selector, 15_000);
  }
}

/** Waits until the member's overlay reports an unread notification (relay + subscriber). */
async function waitForUnreadOverlay(view: Bun.WebView): Promise<void> {
  await waitForExpression(
    view,
    `(async () => {
      const response = await fetch("/api/me/overlay", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bulletin-overlay": "1" },
        body: JSON.stringify({ ctx: "board" })
      });
      if (!response.ok) return false;
      const payload = await response.json();
      return (payload.counts?.notifications ?? 0) > 0;
    })()`,
    30_000,
  );
}

integrationDescribe("notification centre", () => {
  test("following Next shows the next page of notifications", async () => {
    // member-2 has a seeded history longer than one page (page size is 50).
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-2");
        await view.navigate(NOTIFICATIONS_URL);
        await waitForSelector(view, "[data-notifications-page]");
        await waitForSelector(view, "[data-notification-row]");

        const ids = () =>
          view.evaluate<string[]>(
            `[...document.querySelectorAll("[data-notification-row]")]
              .map((row) => row.getAttribute("data-notification-row") ?? "")`,
          );
        const firstPage = await ids();

        expect(firstPage).toHaveLength(50);
        await waitForSelector(view, "[data-page-next]:not([disabled])");
        await clickSelector(view, "[data-page-next]");
        await waitForExpression(
          view,
          'new URLSearchParams(window.location.search).get("page") === "2"',
          10_000,
        );
        await waitForSelector(view, "[data-notification-row]");

        const secondPage = await ids();

        expect(secondPage.length).toBeGreaterThan(0);
        expect(secondPage.length).toBeLessThan(firstPage.length);
        expect(secondPage.some((id) => firstPage.includes(id))).toBe(false);
        await waitForSelector(view, "[data-page-prev]:not([disabled])");
        await clickSelector(view, "[data-page-prev]");
        await waitForExpression(
          view,
          'new URLSearchParams(window.location.search).get("page") === "1"',
          10_000,
        );
        await waitForSelector(view, "[data-notification-row]");

        expect((await ids()).slice(0, 5)).toEqual(firstPage.slice(0, 5));
      },
    );
  }, 180_000);

  for (const viewport of VIEWPORTS) {
    test(`shows the bell, opens and marks all read at ${viewport}`, async () => {
      const topic = await followedTopic();
      await replyToTopic(topic.id);
      let openedRow: string | null = null;

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await waitForUnreadOverlay(view);
          await view.navigate(NOTIFICATIONS_URL);
          await waitForBellCount(view);
          await waitForSelector(view, "[data-notifications-page]");
          await waitForSelector(view, "[data-notification-row]");

          expect(
            await view.evaluate<boolean>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
            ),
          ).toBe(true);

          // Badge and friend entries are notifications without a link; opening one cannot mark
          // it read or navigate. Pick the newest unread entry that can actually be opened.
          openedRow = await view.evaluate<string | null>(
            `document.querySelector(
              '[data-notification-row][data-unread="true"] [data-notification-link]'
            )?.closest("[data-notification-row]")?.getAttribute("data-notification-row") ?? null`,
          );

          if (openedRow === null) {
            throw new Error("Missing unread notification with a link");
          }

          // Opening an unread entry marks it read and navigates to the topic.
          const openedLink = `[data-notification-row="${openedRow}"] [data-notification-link]:not([disabled])`;
          await waitForSelector(view, openedLink);
          await clickSelector(view, openedLink);
          await waitForSelector(view, "[data-topic-page]");
        },
      );

      // A later reply creates a fresh unread row after the opened one was marked read.
      await replyToTopic(topic.id);

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await waitForUnreadOverlay(view);
          await view.navigate(NOTIFICATIONS_URL);
          await waitForSelector(view, "[data-notifications-page]");
          await waitForSelector(
            view,
            `[data-notification-row="${openedRow}"][data-unread="false"]`,
            20_000,
          );
          await waitForBellCount(view);
          expect(
            await view.evaluate<boolean>(
              `document.querySelector('[data-overlay-count="notifications"]').hidden === false`,
            ),
          ).toBe(true);

          // Mark all read clears the remaining unread rows and the bell count.
          const readAll = "[data-notifications-read-all]:not([disabled])";
          await waitForSelector(view, readAll);
          await clickSelector(view, readAll);
          await waitForSelector(view, "[data-notifications-read-status]:not([hidden])", 20_000);
          await waitForExpression(
            view,
            `document.querySelectorAll('[data-notification-row][data-unread="true"]').length === 0`,
            20_000,
          );
          expect(
            await view.evaluate<boolean>(
              `document.querySelector('[data-overlay-count="notifications"]').hidden`,
            ),
          ).toBe(true);
        },
      );
    }, 300_000);
  }
});
