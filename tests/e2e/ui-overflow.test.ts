import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// ui-rebuild task 6.2: nothing on the main user and staff pages scrolls sideways at 360 px
// (ADR 0014, ADR 0021).
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

const OVERFLOW = "document.documentElement.scrollWidth - document.documentElement.clientWidth";

async function settledOverflow(view: Bun.WebView, ready: string): Promise<number> {
  await waitForSelector(view, ready, 20_000);
  // Islands and client tables hydrate after the first paint.
  await Bun.sleep(400);
  return view.evaluate<number>(OVERFLOW);
}

const USER_PAGES: readonly string[] = [
  "/",
  "/members",
  "/members/online",
  "/leaderboards",
  "/search?q=welcome",
  "/account",
  "/account/profile",
  "/account/notifications",
  "/account/notifications/preferences",
  "/account/privacy",
  "/account/attachments",
  "/account/follows",
  "/conversations",
  "/moderation/queue",
];

const STAFF_PAGES: readonly string[] = [
  "/",
  "/log",
  "/members/profiles",
  "/groups",
  "/groups/settings",
  "/permissions",
  "/forums",
  "/moderation",
  "/moderation/bans",
  "/moderation/log",
  "/themes",
  "/plugins",
  "/settings/webhooks",
  "/privacy/access-log",
  "/settings/board",
  "/flags",
  "/system/health",
];

integrationDescribe("no horizontal overflow at 360 px", () => {
  test("user pages, including a forum and a topic", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      const failures: string[] = [];

      for (const path of USER_PAGES) {
        await view.navigate(new URL(path, USER_URL).toString());
        const overflow = await settledOverflow(view, "main");
        if (overflow > 0) failures.push(`${path}: ${overflow}px`);
      }

      await view.navigate(USER_URL);
      await waitForSelector(view, "[data-forum-link]");
      const forumHref = await view.evaluate<string>(
        `document.querySelector("[data-forum-link]").getAttribute("href")`,
      );
      await view.navigate(new URL(forumHref, USER_URL).toString());
      if ((await settledOverflow(view, "main a[href^='/topic/']")) > 0) failures.push(forumHref);

      const topicHref = await view.evaluate<string>(
        `document.querySelector("main a[href^='/topic/']").getAttribute("href")`,
      );
      await view.navigate(new URL(topicHref, USER_URL).toString());
      if ((await settledOverflow(view, "[data-post]")) > 0) failures.push(topicHref);

      expect(failures).toEqual([]);
    });
  }, 240_000);

  test("staff pages", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      const failures: string[] = [];

      for (const path of STAFF_PAGES) {
        await view.navigate(new URL(path, STAFF_URL).toString());
        const overflow = await settledOverflow(view, "main h1");
        if (overflow > 0) failures.push(`${path}: ${overflow}px`);
      }

      expect(failures).toEqual([]);
    });
  }, 240_000);
});
