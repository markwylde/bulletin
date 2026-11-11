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
const TOPIC_TITLE = "Show us your desk setup";
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

/** Finds the seeded topic by title even after earlier runs pushed it onto a later page. */
async function findTopicHref(view: Bun.WebView): Promise<string> {
  for (let page = 0; page < 20; page += 1) {
    await waitForSelector(view, "[data-topic-list]", 20_000);
    const href = await view.evaluate<string | null>(
      `(() => {
        const link = [...document.querySelectorAll('[data-topic-list] [data-topic-link]')].find(
          (element) => element.textContent?.includes(${JSON.stringify(TOPIC_TITLE)})
        );
        return link?.getAttribute('href') ?? null;
      })()`,
    );

    if (href !== null) {
      return href;
    }

    const next = await view.evaluate<string | null>(
      'document.querySelector("[data-page-next]")?.getAttribute("href") ?? null',
    );

    if (next === null) {
      break;
    }

    await view.navigate(new URL(next, USER_URL).toString());
  }

  throw new Error("Missing the seeded reaction topic");
}

function selectedCount(view: Bun.WebView): Promise<number> {
  return view.evaluate<number>(
    'document.querySelectorAll("[data-reaction-pick][data-selected=\\"true\\"]").length',
  );
}

function countOf(view: Bun.WebView, reactionId: string): Promise<number> {
  return view.evaluate<number>(
    `Number(document.querySelector('[data-reaction-count="${reactionId}"]')?.textContent ?? "0")`,
  );
}

async function reactionIds(view: Bun.WebView): Promise<readonly string[]> {
  return view.evaluate<string[]>(
    `[...document.querySelectorAll('[data-reaction-pick]')]
      .map((element) => element.getAttribute('data-reaction-pick') ?? '')
      .filter((id) => id !== '')`,
  );
}

async function clearReaction(view: Bun.WebView): Promise<void> {
  if ((await selectedCount(view)) === 0) {
    return;
  }

  await waitForSelector(view, '[data-reaction-pick][data-selected="true"]:not([disabled])', 20_000);
  await clickSelector(view, '[data-reaction-pick][data-selected="true"]:not([disabled])');
  await waitForExpression(
    view,
    'document.querySelectorAll("[data-reaction-pick][data-selected=\\"true\\"]").length === 0',
    20_000,
  );
}

integrationDescribe("reaction bar", () => {
  for (const viewport of VIEWPORTS) {
    test(`reacts, changes and removes a reaction at ${viewport}`, async () => {
      await withPage(
        {
          url: USER_URL,
          viewport,
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await view.navigate(FORUM_URL);
          const href = await findTopicHref(view);
          const topicUrl = new URL(href, USER_URL).toString();
          await view.navigate(topicUrl);

          await waitForSelector(view, "[data-topic-page]", 20_000);
          await waitForSelector(
            view,
            'bl-island[data-name="Reactions"][data-hydrated="true"] [data-reaction-bar]',
            20_000,
          );
          await waitForExpression(
            view,
            'document.documentElement.dataset.overlayApplied === "true"',
            20_000,
          );

          const ids = await reactionIds(view);
          expect(ids.length).toBeGreaterThan(1);
          const first = ids[0] ?? "";
          const second = ids[1] ?? "";
          await clearReaction(view);

          const baseline = await countOf(view, first);
          const baselineSecond = await countOf(view, second);

          await clickSelector(view, `[data-reaction-pick="${first}"]:not([disabled])`);
          await waitForExpression(
            view,
            `document.querySelector('[data-reaction-pick="${first}"]')?.getAttribute('data-selected') === 'true'`,
            20_000,
          );
          expect(await countOf(view, first)).toBe(baseline + 1);

          // Reload: the overlay restores the member's own reaction on the shared cached bar.
          await view.navigate(topicUrl);
          await waitForExpression(
            view,
            `document.documentElement.dataset.overlayApplied === "true" &&
             document.querySelector('[data-reaction-pick="${first}"]')?.getAttribute('data-selected') === 'true'`,
            20_000,
          );
          expect(await countOf(view, first)).toBe(baseline + 1);

          // Change: the post shows one reaction from the member and no previous one.
          await waitForSelector(view, `[data-reaction-pick="${second}"]:not([disabled])`, 20_000);
          await clickSelector(view, `[data-reaction-pick="${second}"]:not([disabled])`);
          await waitForExpression(
            view,
            `document.querySelector('[data-reaction-pick="${second}"]')?.getAttribute('data-selected') === 'true' &&
             document.querySelector('[data-reaction-pick="${first}"]')?.getAttribute('data-selected') === 'false'`,
            20_000,
          );
          expect(await countOf(view, first)).toBe(baseline);

          // Who reacted: the list names the member who picked this reaction.
          await waitForSelector(view, "[data-reaction-who]:not([disabled])", 20_000);
          await clickSelector(view, "[data-reaction-who]:not([disabled])");
          await waitForSelector(view, "[data-reaction-dialog][open] [data-reaction-group]", 20_000);
          await waitForExpression(
            view,
            `[...document.querySelectorAll('[data-reaction-dialog] [data-reaction-group] li')].some(
              (element) => element.textContent?.includes('Regular Member One')
            )`,
            20_000,
          );
          await clickSelector(view, "[data-reaction-dialog] .bl-dialog__header button");
          await waitForExpression(
            view,
            'document.querySelector("[data-reaction-dialog]")?.hasAttribute("open") === false',
            20_000,
          );

          // Remove by picking the same reaction again.
          await waitForSelector(view, `[data-reaction-pick="${second}"]:not([disabled])`, 20_000);
          await clickSelector(view, `[data-reaction-pick="${second}"]:not([disabled])`);
          await waitForExpression(
            view,
            'document.querySelectorAll("[data-reaction-pick][data-selected=\\"true\\"]").length === 0',
            20_000,
          );
          expect(await countOf(view, second)).toBe(baselineSecond);

          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        },
      );
    }, 180_000);
  }
});

integrationDescribe("staff reaction set", () => {
  test("creates and deletes a reaction at 360 px", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await view.navigate(new URL("/reactions", STAFF_URL).toString());
      await waitForSelector(view, '[data-page="reactions"]');
      await waitForSelector(view, "[data-reaction-row]", 20_000);

      expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(360);
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);

      const suffix = String(Date.now());
      const key = `e2e_${suffix}`;
      await clickSelector(view, "[data-reaction-new]");
      await setInputValue(view, "[data-reaction-key]", key);
      await setInputValue(view, "[data-reaction-icon]", "🔥");
      await waitForSelector(view, "[data-reaction-save]:not([disabled])", 20_000);
      await clickSelector(view, "[data-reaction-save]");
      await waitForExpression(
        view,
        `document.body.innerText.includes(${JSON.stringify(key)})`,
        20_000,
      );

      await waitForSelector(
        view,
        `[data-reaction-row] [data-reaction-edit]:not([disabled])`,
        20_000,
      );
      const rowId = await view.evaluate<string>(
        `(() => {
          const row = [...document.querySelectorAll('[data-reaction-row]')].find((element) =>
            element.textContent?.includes(${JSON.stringify(key)})
          );
          return row?.getAttribute('data-reaction-row') ?? '';
        })()`,
      );
      expect(rowId).toMatch(/^\d+$/);

      await waitForSelector(view, `[data-reaction-edit="${rowId}"]:not([disabled])`, 20_000);
      await clickSelector(view, `[data-reaction-edit="${rowId}"]:not([disabled])`);
      await waitForSelector(view, "[data-reaction-delete]:not([disabled])", 20_000);
      await clickSelector(view, "[data-reaction-delete]:not([disabled])");
      await waitForSelector(view, "[data-confirm-dialog] [data-confirm-action]", 20_000);
      await clickSelector(view, "[data-confirm-dialog] [data-confirm-action]");
      await waitForExpression(
        view,
        `!document.body.innerText.includes(${JSON.stringify(key)})`,
        20_000,
      );
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 180_000);
});
