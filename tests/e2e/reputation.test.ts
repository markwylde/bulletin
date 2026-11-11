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
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

/** Topic permalinks from the off-topic list (up to three pages). */
async function topicHrefs(view: Bun.WebView): Promise<readonly string[]> {
  const hrefs: string[] = [];

  for (let page = 0; page < 5; page += 1) {
    await waitForSelector(view, "[data-topic-list]", 20_000);
    const found = await view.evaluate<string[]>(
      `[...document.querySelectorAll('[data-topic-list] [data-topic-link]')]
        .map((element) => element.getAttribute('href') ?? '')
        .filter((href) => href.startsWith('/topic/'))`,
    );
    hrefs.push(...found);
    const next = await view.evaluate<string | null>(
      'document.querySelector("[data-page-next]")?.getAttribute("href") ?? null',
    );

    if (next === null) {
      break;
    }

    await view.navigate(new URL(next, USER_URL).toString());
  }

  return [...new Set(hrefs)];
}

/**
 * Finds a post this member has not rated yet. A fresh CI database finds one in the first
 * topics; the loop keeps repeated local runs working after earlier runs spent the obvious ones.
 */
async function findUnratedPost(
  view: Bun.WebView,
): Promise<{ readonly url: string; readonly postId: string } | null> {
  await view.navigate(FORUM_URL);
  const hrefs = await topicHrefs(view);

  for (const href of hrefs.slice(0, 60)) {
    const url = new URL(href, USER_URL).toString();
    await view.navigate(url);
    await waitForSelector(view, "[data-topic-page]", 20_000);
    // Own posts and votes already given arrive with the overlay, so scan only after it.
    await waitForExpression(
      view,
      'document.documentElement.dataset.overlayApplied === "true"',
      20_000,
    ).catch(() => undefined);

    const found = await view.evaluate<string | null>(`(() => {
      const post = [...document.querySelectorAll('[data-post]')].find((element) =>
        element.querySelector('[data-reputation-vote="1"]:not([disabled])')
      );
      return post?.getAttribute('data-post') ?? null;
    })()`);

    if (found !== null) {
      // Islands hydrate when they scroll near the viewport; bring this post into view and
      // re-check after the overlay has had its say (it may already be voted or the own post).
      await view.evaluate(
        `document.querySelector('[data-post="${found}"]')?.scrollIntoView({ block: "center" })`,
      );
      await waitForSelector(
        view,
        `[data-post="${found}"] bl-island[data-name="PostReputation"][data-hydrated="true"]`,
        10_000,
      ).catch(() => null);
      const clickable = await view.evaluate<boolean>(
        `document.querySelector('[data-post="${found}"] [data-reputation-vote="1"]:not([disabled])') !== null`,
      );

      if (clickable) {
        return { url, postId: found };
      }
    }
  }

  return null;
}

integrationDescribe("reputation", () => {
  for (const viewport of VIEWPORTS) {
    test(`gives reputation from a post and restores it from the overlay at ${viewport}`, async () => {
      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          const target = await findUnratedPost(view);

          if (target === null) {
            throw new Error("No unrated post found in the seeded topics");
          }

          const { postId } = target;
          await waitForSelector(
            view,
            `[data-post="${postId}"] [data-reputation-vote="1"]:not([disabled])`,
            20_000,
          );

          const before = await view.evaluate<number>(`Number(
            document.querySelector('[data-post="${postId}"] [data-reputation-count]')?.textContent ?? "0"
          )`);

          await clickSelector(view, `[data-post="${postId}"] [data-reputation-vote="1"]`);
          await waitForSelector(
            view,
            `[data-post="${postId}"] [data-reputation-given="1"]`,
            20_000,
          );
          expect(
            await view.evaluate<number>(`Number(
              document.querySelector('[data-post="${postId}"] [data-reputation-count]')?.textContent ?? "0"
            )`),
          ).toBe(before + 1);

          // A reload restores the member's own vote from the private overlay. The island
          // hydrates when scrolled near, so bring the post back into view first.
          await view.navigate(target.url);
          await view.evaluate(
            `document.querySelector('[data-post="${postId}"]')?.scrollIntoView({ block: "center" })`,
          );
          await waitForSelector(
            view,
            `[data-post="${postId}"] bl-island[data-name="PostReputation"][data-hydrated="true"]`,
            20_000,
          );
          await waitForExpression(
            view,
            `document.documentElement.dataset.overlayApplied === "true" &&
             document.querySelector('[data-post="${postId}"] [data-reputation-given="1"]') !== null`,
            20_000,
          );

          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        },
      );
    }, 240_000);
  }

  test("the staff reputation tools stay usable at 360 px", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      const session = await view.evaluate<{ memberId?: string }>(
        'fetch("/api/auth/session").then((response) => response.json())',
      );
      expect(session.memberId).toMatch(/^\d+$/);

      await view.navigate(new URL("/members/reputation", STAFF_URL).toString());
      await waitForSelector(view, '[data-page="member-reputation"]');
      await setInputValue(view, "[data-reputation-member]", session.memberId ?? "");
      await waitForSelector(view, "[data-reputation-load]:not([disabled])", 20_000);
      await clickSelector(view, "[data-reputation-load]");
      await waitForSelector(view, "[data-reputation-total]", 20_000);

      expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(360);
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 180_000);
});
