import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";
import { findTopicHref } from "./support/topic-links.ts";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

interface ProfileTarget {
  readonly path: string;
  readonly memberId: string;
  readonly topicUrl: string;
}

async function openProfile(
  view: Bun.WebView,
  topicTitle: string,
  memberName: string,
): Promise<ProfileTarget> {
  const topic = await findTopicHref(view, "/forum/5-off-topic", topicTitle);

  if (topic === null) {
    throw new Error(`Missing seeded topic ${topicTitle}`);
  }

  const topicUrl = new URL(topic, USER_URL).toString();
  await view.navigate(topicUrl);
  await waitForSelector(view, "[data-topic-page]", 20_000);

  const path = await view.evaluate<string | null>(`(() => {
    const link = [...document.querySelectorAll('a[href^="/profile/"]')].find(
      (element) => element.textContent?.trim() === ${JSON.stringify(memberName)}
    );
    return link?.getAttribute("href") ?? null;
  })()`);

  if (path === null) {
    throw new Error(`Missing profile link for ${memberName}`);
  }

  await view.navigate(new URL(path, USER_URL).toString());
  await waitForSelector(view, "[data-profile-page]", 20_000);
  await waitForSelector(view, "[data-member-actions]", 20_000);

  const memberId = await view.evaluate<string>(
    'document.querySelector("[data-profile-page]")?.getAttribute("data-profile-member") ?? ""',
  );

  return { path, memberId, topicUrl };
}

async function logout(view: Bun.WebView): Promise<void> {
  await view.navigate(USER_URL);
  await waitForSelector(view, "[data-logout]:not([hidden])", 20_000);
  await clickSelector(view, "[data-logout]");
  await waitForSelector(view, "[data-login]:not([hidden])", 20_000);
}

integrationDescribe("member relationships", () => {
  test("requests, accepts and removes a friendship at 360px", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        await openProfile(view, "Show us your desk setup", "Regular Member Two");
        await waitForSelector(view, "[data-member-actions]:not([hidden])", 20_000);

        // Recover from a previously interrupted run.
        if (
          (await view.evaluate<string>(
            'document.querySelector("[data-ignore-toggle]")?.getAttribute("data-ignoring") ?? "false"',
          )) === "true"
        ) {
          await clickSelector(view, "[data-ignore-toggle]");
          await waitForExpression(
            view,
            'document.querySelector("[data-ignore-toggle]")?.getAttribute("data-ignoring") === "false"',
            20_000,
          );
        }

        if (
          await view.evaluate<boolean>(
            'document.querySelector("[data-friend-remove]")?.hidden === false',
          )
        ) {
          await clickSelector(view, "[data-friend-remove]");
          await waitForSelector(view, "[data-friend-request]:not([hidden])", 20_000);
        }

        await waitForSelector(view, "[data-friend-request]:not([hidden])", 20_000);
        await clickSelector(view, "[data-friend-request]");
        await waitForSelector(view, "[data-friend-pending]:not([hidden])", 20_000);

        await logout(view);
        await loginAs(view, "member-2");
        await openProfile(view, "What are you reading this month?", "Regular Member One");
        await waitForSelector(view, "[data-friend-accept]:not([hidden])", 20_000);
        await clickSelector(view, "[data-friend-accept]");
        await waitForSelector(view, "[data-friend-remove]:not([hidden])", 20_000);

        await logout(view);
        await loginAs(view, "member-1");
        await openProfile(view, "Show us your desk setup", "Regular Member Two");
        await waitForSelector(view, "[data-profile-friends]", 20_000);
        await waitForText(view, "Regular Member One", 20_000);
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        await waitForSelector(view, "[data-friend-remove]:not([hidden])", 20_000);
        await clickSelector(view, "[data-friend-remove]");
        await waitForSelector(view, "[data-friend-request]:not([hidden])", 20_000);
      },
    );
  }, 240_000);

  test("ignores a member, collapses their posts and reveals them at 360px", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        const target = await openProfile(view, "Show us your desk setup", "Regular Member Two");

        await waitForSelector(view, "[data-ignore-toggle]:not([hidden])", 20_000);
        await clickSelector(view, "[data-ignore-toggle]");
        await waitForExpression(
          view,
          'document.querySelector("[data-ignore-toggle]")?.getAttribute("data-ignoring") === "true"',
          20_000,
        );

        await view.navigate(target.topicUrl);
        await waitForSelector(view, "[data-topic-page]", 20_000);
        await waitForExpression(
          view,
          'document.documentElement.dataset.overlayApplied === "true"',
          20_000,
        );
        await waitForExpression(
          view,
          `document.querySelector('[data-post][data-author="${target.memberId}"]')?.classList.contains("bl-post--ignored") === true`,
          20_000,
        );

        const collapsedText = await view.evaluate<string>(
          `document.querySelector('[data-post][data-author="${target.memberId}"] [data-post-ignored]')?.textContent ?? ""`,
        );
        expect(collapsedText).toContain("You are ignoring this member");

        await clickSelector(
          view,
          `[data-post][data-author="${target.memberId}"] [data-post-reveal]`,
        );
        await waitForExpression(
          view,
          `document.querySelector('[data-post][data-author="${target.memberId}"]')?.classList.contains("bl-post--ignored") === false`,
          20_000,
        );

        // Leave the member unignored for the next run.
        await view.navigate(new URL(target.path, USER_URL).toString());
        await waitForSelector(view, "[data-ignore-toggle]:not([hidden])", 20_000);
        await clickSelector(view, "[data-ignore-toggle]");
        await waitForExpression(
          view,
          'document.querySelector("[data-ignore-toggle]")?.getAttribute("data-ignoring") === "false"',
          20_000,
        );
      },
    );
  }, 180_000);
});
