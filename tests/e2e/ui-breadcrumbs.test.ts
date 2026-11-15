import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// ui-rebuild task 6.2: breadcrumbs on every page except the board index (ADR 0021), driven by
// the view model. Each trail starts at Home, ends at the current page and links every level
// in between.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

interface Crumb {
  readonly label: string;
  readonly href: string | null;
  readonly current: boolean;
}

async function trail(view: Bun.WebView): Promise<readonly Crumb[]> {
  await waitForSelector(view, "[data-breadcrumbs]");

  return view.evaluate<Crumb[]>(`[...document.querySelectorAll("[data-breadcrumbs] li")].map(
    (item) => ({
      label: item.textContent.trim().replace(/\\s+/g, " "),
      href: item.querySelector("a")?.getAttribute("href") ?? null,
      current: Boolean(item.querySelector("[aria-current='page']")),
    }),
  )`);
}

function expectWellFormed(crumbs: readonly Crumb[]): void {
  expect(crumbs.length).toBeGreaterThanOrEqual(2);
  expect(crumbs[0]?.href).toBe("/");
  expect(crumbs.filter((crumb) => crumb.current)).toHaveLength(1);
  expect(crumbs.at(-1)?.current).toBe(true);
  expect(crumbs.at(-1)?.href).toBeNull();

  for (const crumb of crumbs.slice(0, -1)) {
    expect(crumb.href).not.toBeNull();
    expect(crumb.label.length).toBeGreaterThan(0);
  }
}

async function goTo(view: Bun.WebView, path: string): Promise<void> {
  await view.navigate(new URL(path, USER_URL).toString());
}

async function firstHref(view: Bun.WebView, selector: string): Promise<string> {
  await waitForSelector(view, selector);
  return view.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)}).getAttribute("href")`,
  );
}

integrationDescribe("breadcrumbs", () => {
  test("trails are correct across forum, topic, profile, search, account and conversations", async () => {
    await withPage({ url: USER_URL, viewport: "desktop" }, async (view) => {
      await loginAs(view, "member-1");

      // The board index has no trail.
      await goTo(view, "/");
      await waitForSelector(view, "[data-forum-link]");
      expect(
        await view.evaluate<boolean>("Boolean(document.querySelector('[data-breadcrumbs]'))"),
      ).toBe(false);

      // Forum: Home › … › Forum, the current crumb matching the page title.
      const forumHref = await firstHref(view, "[data-forum-link]");
      await goTo(view, forumHref);
      const forum = await trail(view);
      expectWellFormed(forum);
      expect(forum.at(-1)?.label).toBe(
        await view.evaluate<string>('document.querySelector("h1").textContent.trim()'),
      );

      // Topic: the trail links back to its forum.
      const topicHref = await firstHref(view, "main a[href^='/topic/']");
      await goTo(view, topicHref);
      const topic = await trail(view);
      expectWellFormed(topic);
      expect(topic.some((crumb) => crumb.href?.startsWith("/forum/"))).toBe(true);

      // Profile: Home › Member name.
      const profileHref = await firstHref(view, "main a[href^='/profile/']");
      await goTo(view, profileHref);
      const profile = await trail(view);
      expectWellFormed(profile);

      // Search: Home › Search.
      await goTo(view, "/search?q=welcome");
      const search = await trail(view);
      expectWellFormed(search);
      expect(search).toHaveLength(2);

      // Account: Home › Your account.
      await goTo(view, "/account");
      const account = await trail(view);
      expectWellFormed(account);
      expect(account).toHaveLength(2);
      const accountLabel = account.at(-1)?.label;

      // Account pages: Home › Your account › Page.
      for (const path of ["/account/profile", "/account/notifications", "/account/privacy"]) {
        await goTo(view, path);
        const crumbs = await trail(view);
        expectWellFormed(crumbs);
        expect(crumbs[1]).toEqual({ label: accountLabel ?? "", href: "/account", current: false });
      }

      // Conversations: Home › Your account › Conversations, then the thread below it.
      await goTo(view, "/conversations");
      const conversations = await trail(view);
      expectWellFormed(conversations);
      expect(conversations).toHaveLength(3);
      expect(conversations[1]?.href).toBe("/account");

      const threadHref = await firstHref(view, "main a[href^='/conversations/']");
      await goTo(view, threadHref);
      const thread = await trail(view);
      expectWellFormed(thread);
      expect(thread).toHaveLength(4);
      expect(thread[2]?.href).toBe("/conversations");
    });
  }, 180_000);
});
