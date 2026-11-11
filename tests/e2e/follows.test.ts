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
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

function withinWidth(view: Bun.WebView): Promise<boolean> {
  return view.evaluate<boolean>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
  );
}

async function followState(view: Bun.WebView, context: string): Promise<string | null> {
  return view.evaluate<string | null>(
    `document.querySelector('[data-follow-context="${context}"]')?.getAttribute("data-following") ?? null`,
  );
}

async function waitForFollowState(
  view: Bun.WebView,
  context: string,
  following: boolean,
): Promise<void> {
  await waitForExpression(
    view,
    `document.querySelector('[data-follow-context="${context}"]')?.getAttribute("data-following") === "${following}"`,
    20_000,
  );
}

async function setFollow(view: Bun.WebView, context: string, following: boolean): Promise<void> {
  await waitForExpression(
    view,
    `document.querySelector('[data-follow-context="${context}"]')?.getAttribute("data-following") !== null`,
    20_000,
  );

  if ((await followState(view, context)) === String(following)) {
    return;
  }

  const action = following ? "follow" : "unfollow";
  const selector = `[data-follow-context="${context}"] [data-follow-action="${action}"]:not([disabled])`;
  await waitForSelector(view, selector, 20_000);
  await clickSelector(view, selector);
  await waitForFollowState(view, context, following);
}

integrationDescribe("follow buttons and the follows page", () => {
  for (const viewport of VIEWPORTS) {
    test(`follows a forum and a topic at ${viewport}`, async () => {
      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await view.navigate(FORUM_URL);
          await waitForSelector(view, "[data-forum-page]");

          await setFollow(view, "forum:5", false);
          expect(
            await view.evaluate<boolean>(
              'document.querySelector(\'[data-follow-context="forum:5"] [data-follow-action="unfollow"]\').hidden',
            ),
          ).toBe(true);

          await setFollow(view, "forum:5", true);
          expect(await withinWidth(view)).toBe(true);

          // Reload: the overlay restores the member's own state on the shared cached page.
          await view.navigate(FORUM_URL);
          await waitForSelector(view, "[data-forum-page]");
          await waitForFollowState(view, "forum:5", true);

          const href = await view.evaluate<string | null>(
            'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
          );

          if (href === null) {
            throw new Error("Missing topic link");
          }

          await view.navigate(new URL(href, USER_URL).toString());
          await waitForSelector(view, "[data-topic-page]");
          const topicId = await view.evaluate<string>(
            'document.querySelector("[data-topic-page]")?.getAttribute("data-topic-id") ?? ""',
          );
          expect(topicId).toMatch(/^\d+$/);

          await setFollow(view, `topic:${topicId}`, true);
          expect(await withinWidth(view)).toBe(true);

          await view.navigate(new URL("/account/follows", USER_URL).toString());
          await waitForSelector(view, "[data-follows-page]");
          await waitForSelector(view, '[data-follow-row="forum:5"]');
          await waitForSelector(view, `[data-follow-row="topic:${topicId}"]`);
          expect(await withinWidth(view)).toBe(true);

          // Unfollow the forum from the follows page; the row disappears.
          const remove = '[data-follow-row="forum:5"] [data-follow-remove]:not([disabled])';
          await waitForSelector(view, remove);
          await clickSelector(view, remove);
          await waitForExpression(
            view,
            "!document.querySelector('[data-follow-row=\"forum:5\"]')",
            20_000,
          );

          // Auto-follow is on by default; toggling persists across a reload.
          await waitForSelector(view, "[data-auto-follow]");
          const checked = await view.evaluate<boolean>(
            'document.querySelector("[data-auto-follow]").checked',
          );

          if (checked) {
            await clickSelector(view, "[data-auto-follow]");
            await waitForSelector(view, "[data-auto-follow-status]:not([hidden])");
          }

          await view.navigate(new URL("/account/follows", USER_URL).toString());
          await waitForSelector(view, "[data-follows-page]");
          expect(
            await view.evaluate<boolean>('document.querySelector("[data-auto-follow]").checked'),
          ).toBe(false);

          await clickSelector(view, "[data-auto-follow]");
          await waitForSelector(view, "[data-auto-follow-status]:not([hidden])");
        },
      );
    }, 180_000);
  }

  test("guests never see follow controls", async () => {
    await withPage({ url: FORUM_URL, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-forum-page]");
      await waitForSelector(view, "[data-overlay-ctx]");

      expect(
        await view.evaluate<boolean>(
          "document.querySelector('[data-follow-context=\"forum:5\"]').hidden",
        ),
      ).toBe(true);
    });
  }, 120_000);
});
