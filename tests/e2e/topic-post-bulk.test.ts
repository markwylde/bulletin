import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Carried-over moderation finding: the split and bulk post handlers both read
// `[data-bulk-post-check]`, so the default theme must render selectable posts for
// moderators who can only split as well as for bulk delete/restore moderators.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();

/** The seeded long topic's last page, so the first post (which cannot be split) is absent. */
async function openLongTopicLastPage(view: Bun.WebView): Promise<void> {
  await view.navigate(FORUM_URL);
  await waitForSelector(view, "[data-topic-list] [data-topic-link]", 20_000);
  const href = await view.evaluate<string | null>(`(() => {
    const link = [...document.querySelectorAll('[data-topic-list] [data-topic-link]')].find(
      (element) => element.textContent?.includes("Long running discussion")
    );
    return link?.getAttribute("href") ?? null;
  })()`);

  if (href === null) {
    throw new Error("Missing the seeded long-running topic");
  }

  await view.navigate(new URL(`${href}/page/99`, USER_URL).toString());
  await waitForSelector(view, "[data-post-list]", 20_000);
  await waitForExpression(view, 'document.readyState === "complete"', 20_000);
}

async function selectablePostIds(view: Bun.WebView): Promise<readonly string[]> {
  await waitForSelector(view, "[data-bulk-post-check]", 20_000);

  return view.evaluate<string[]>(`(() => {
    return [...document.querySelectorAll('[data-bulk-post-check]')]
      .filter((input) =>
        document.querySelector('[data-post="' + input.value + '"] [data-post-body]') !== null
      )
      .map((input) => input.value);
  })()`);
}

function selectPostExpression(id: string): string {
  return `(() => {
    const input = [...document.querySelectorAll('[data-bulk-post-check]')].find(
      (element) => element.value === ${JSON.stringify(id)}
    );
    if (!(input instanceof HTMLInputElement)) return false;
    input.checked = true;
    return input.checked;
  })()`;
}

integrationDescribe("post moderation selections at mobile360", () => {
  test("splits a selected post into a new topic", async () => {
    const splitTitle = `Split from the long topic ${Date.now()}`;

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "super-mod");
      await openLongTopicLastPage(view);

      const ids = await selectablePostIds(view);
      const selected = ids[ids.length - 1];

      if (selected === undefined) {
        throw new Error("The last page has no selectable post");
      }

      const body = await view.evaluate<string | null>(
        `document.querySelector('[data-post="${selected}"] [data-post-body]')?.textContent ?? null`,
      );

      if (body === null || body.trim() === "") {
        throw new Error("Missing the selected post's body");
      }

      await view.evaluate(selectPostExpression(selected));
      await clickSelector(view, "[data-topic-tools] summary");
      await waitForSelector(view, "#topic-split-title", 20_000);
      await setInputValue(view, "#topic-split-title", splitTitle);
      await waitForSelector(view, "[data-topic-split-submit]:not([disabled])", 20_000);
      await clickSelector(view, "[data-topic-split-submit]");

      await waitForExpression(
        view,
        `document.querySelector('[data-post="${selected}"]') === null`,
        30_000,
      );

      // The new topic carries the moved post and is linked from the forum list.
      await view.navigate(FORUM_URL);
      await waitForSelector(view, "[data-topic-list]", 20_000);
      const href = await view.evaluate<string | null>(`(() => {
        const link = [...document.querySelectorAll('[data-topic-list] [data-topic-link]')].find(
          (element) => element.textContent?.includes(${JSON.stringify(splitTitle)})
        );
        return link?.getAttribute("href") ?? null;
      })()`);

      if (href === null) {
        throw new Error("The split topic is missing from the forum list");
      }

      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, "[data-post-list]", 20_000);
      await waitForExpression(
        view,
        `document.querySelector('[data-post-list]')?.textContent?.includes(${JSON.stringify(body.trim())}) === true`,
        20_000,
      );
    });
  }, 120_000);

  test("soft-deletes and restores selected posts in bulk", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "super-mod");
      await openLongTopicLastPage(view);

      const ids = await selectablePostIds(view);
      const selected = ids[ids.length - 1];

      if (selected === undefined) {
        throw new Error("The last page has no selectable post");
      }

      await view.evaluate(selectPostExpression(selected));
      await waitForSelector(view, '[data-bulk-post-action="soft_delete"]:not([disabled])', 20_000);
      await clickSelector(view, '[data-bulk-post-action="soft_delete"]');
      await waitForSelector(view, `[data-post="${selected}"] [data-post-deleted]`, 30_000);
      await waitForExpression(view, 'document.readyState === "complete"', 20_000);

      // Chrome may restore the old checkbox state after the reload; set it explicitly.
      await view.evaluate(selectPostExpression(selected));
      await waitForSelector(view, '[data-bulk-post-action="restore"]:not([disabled])', 20_000);
      await clickSelector(view, '[data-bulk-post-action="restore"]');
      await waitForExpression(
        view,
        `document.querySelector('[data-post="${selected}"] [data-post-deleted]') === null`,
        30_000,
      );

      expect(
        await view.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBeLessThanOrEqual(1);
    });
  }, 120_000);
});
