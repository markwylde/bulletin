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
import { findTopicHref } from "./support/topic-links.ts";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

const TOPIC_TITLE = "Show us your desk setup";

/** Finds a seeded topic by title across the off-topic pages. */
async function findTopicHrefByTitle(view: Bun.WebView, title: string): Promise<string> {
  const href = await findTopicHref(view, "/forum/5-off-topic", title);

  if (href === null) {
    throw new Error(`Missing the topic ${title}`);
  }

  return href;
}

interface FirstPost {
  readonly postId: string;
  readonly authorId: string;
}

async function firstPost(view: Bun.WebView): Promise<FirstPost> {
  return view.evaluate<FirstPost>(`(() => {
    const post = document.querySelector('[data-post]');
    const card = post?.querySelector('[data-member-card]');
    return {
      postId: post?.getAttribute('data-post') ?? '',
      authorId: card?.getAttribute('data-member-card') ?? '',
    };
  })()`);
}

async function memberIdOf(view: Bun.WebView): Promise<string> {
  return view.evaluate<string>(
    'fetch("/api/auth/session").then((response) => response.json()).then((body) => typeof body.memberId === "string" ? body.memberId : "")',
  );
}

/** The seeded board has a small daily allowance; E2E runs must not exhaust it. */
async function raiseDailyLimit(view: Bun.WebView): Promise<void> {
  const csrf = await view.evaluate<string | null>(
    'fetch("/api/auth/session").then((response) => response.json()).then((body) => body.csrfToken)',
  );
  const listed = await view.evaluate<string>(
    'fetch("/api/staff/groups").then((response) => response.text())',
  );
  const groups = (
    JSON.parse(listed) as {
      groups: Array<{ readonly id: string; readonly key: string }>;
    }
  ).groups;
  const members = groups.find((group) => group.key === "members");

  if (members === undefined) {
    throw new Error("Missing the Members group");
  }

  const saved = await view.evaluate<string>(
    `fetch("/api/staff/groups", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": ${JSON.stringify(csrf ?? "")},
      },
      body: JSON.stringify(${JSON.stringify({
        action: "setting",
        groupId: members.id,
        key: "posting.reputation_daily_limit",
        value: 1000,
      })}),
    }).then(async (response) => response.status + ":" + (await response.text()))`,
  );
  expect(saved.startsWith("200:")).toBe(true);
}

/** Staff remove an existing vote so the give test starts from a known state. */
async function clearVote(
  view: Bun.WebView,
  authorId: string,
  postId: string,
  giverId: string,
): Promise<void> {
  const csrf = await view.evaluate<string | null>(
    'fetch("/api/auth/session").then((response) => response.json()).then((body) => body.csrfToken)',
  );
  const listed = await view.evaluate<string>(
    `fetch("/api/staff/members/reputation?memberId=${authorId}").then((response) => response.text())`,
  );
  const entries =
    (
      JSON.parse(listed) as {
        entries?: Array<{
          readonly id: string;
          readonly postId: string;
          readonly giverId: string | null;
          readonly source: string;
        }>;
      }
    ).entries ?? [];
  const entry = entries.find(
    (candidate) =>
      candidate.postId === postId && candidate.giverId === giverId && candidate.source === "vote",
  );

  if (entry === undefined) {
    return;
  }

  const removed = await view.evaluate<string>(
    `fetch("/api/staff/members/reputation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-csrf": ${JSON.stringify(csrf ?? "")},
      },
      body: JSON.stringify(${JSON.stringify({ action: "remove", memberId: authorId, entryId: entry.id })}),
    }).then(async (response) => response.status + ":" + (await response.text()))`,
  );
  expect(removed.startsWith("200:")).toBe(true);
}

integrationDescribe("reputation", () => {
  for (const viewport of VIEWPORTS) {
    test(`gives reputation from a post and restores it from the overlay at ${viewport}`, async () => {
      let memberId = "";
      let authorId = "";
      let postId = "";
      let topicUrl = "";

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          memberId = await memberIdOf(view);
          expect(memberId).toMatch(/^\d+$/);
          const href = await findTopicHrefByTitle(view, TOPIC_TITLE);
          topicUrl = new URL(href, USER_URL).toString();
          await view.navigate(topicUrl);
          await waitForSelector(view, "[data-topic-page]", 20_000);
          await waitForExpression(
            view,
            'document.documentElement.dataset.overlayApplied === "true"',
            20_000,
          );
          const first = await firstPost(view);
          expect(first.postId).toMatch(/^\d+$/);
          expect(first.authorId).toMatch(/^\d+$/);
          postId = first.postId;
          authorId = first.authorId;
        },
      );

      // The staff clear any earlier vote from this member so every run starts unrated.
      await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "admin");
        await view.navigate(new URL("/", STAFF_URL).toString());
        await raiseDailyLimit(view);
        await clearVote(view, authorId, postId, memberId);
      });

      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await view.navigate(topicUrl);
          await view.evaluate(
            `document.querySelector('[data-post="${postId}"]')?.scrollIntoView({ block: "center" })`,
          );
          await waitForExpression(
            view,
            'document.documentElement.dataset.overlayApplied === "true"',
            20_000,
          );
          await waitForSelector(
            view,
            `[data-post="${postId}"] bl-island[data-name="PostReputation"][data-hydrated="true"]`,
            20_000,
          );
          await waitForSelector(
            view,
            `[data-post="${postId}"] [data-reputation-vote="1"]:not([disabled])`,
            20_000,
          );

          const before = await view.evaluate<number>(`Number(
            document.querySelector('[data-post="${postId}"] [data-reputation-count]')?.textContent ?? "0"
          )`);

          await clickSelector(
            view,
            `[data-post="${postId}"] [data-reputation-vote="1"]:not([disabled])`,
          );
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

          // A reload restores the member's own vote from the private overlay.
          await view.navigate(topicUrl);
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

  test("seeded reputation totals render on a topic page at 360 px", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await view.navigate(FORUM_URL);
      const href = await findTopicHrefByTitle(view, "Show us your desk setup");
      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, "[data-topic-page]", 20_000);

      const totals = await view.evaluate<
        number[]
      >(`[...document.querySelectorAll('[data-reputation-count]')]
        .map((element) => Number(element.textContent ?? "0"))`);

      expect(totals.length).toBeGreaterThan(0);
      expect(Math.max(...totals)).toBeGreaterThan(0);
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 120_000);

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
