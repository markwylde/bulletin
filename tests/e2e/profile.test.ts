import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  VIEWPORTS,
  type ViewportName,
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
const TOPIC_TITLE = "What are you reading this month?";
const MEMBER_NAME = "Regular Member One";
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];
const ABOUT_TEXT = "E2E profile about section";

function withinWidth(view: Bun.WebView): Promise<boolean> {
  return view.evaluate<boolean>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
  );
}

/** Finds a member's profile link on one of their posts, without a member-only API. */
async function seededProfilePath(view: Bun.WebView): Promise<string> {
  const topicHref = await findTopicHref(view, "/forum/5-off-topic", TOPIC_TITLE);

  if (topicHref === null) {
    throw new Error("The seeded profile topic is missing");
  }

  await view.navigate(new URL(topicHref, USER_URL).toString());
  await waitForSelector(view, "[data-topic-page]", 20_000);

  const href = await view.evaluate<string | null>(`(() => {
    const link = [...document.querySelectorAll('a[href^="/profile/"]')].find(
      (element) => element.textContent?.trim() === ${JSON.stringify(MEMBER_NAME)}
    );
    return link?.getAttribute("href") ?? null;
  })()`);

  if (href === null) {
    throw new Error("The seeded member's profile link is missing");
  }

  return href;
}

integrationDescribe("member profile page", () => {
  for (const viewport of VIEWPORT_NAMES) {
    test(`renders a profile at ${viewport}`, async () => {
      await withPage({ url: USER_URL, viewport }, async (view) => {
        const path = await seededProfilePath(view);

        await view.navigate(new URL(path, USER_URL).toString());
        await waitForSelector(view, "[data-profile-page]", 20_000);
        await waitForText(view, "Regular Member One", 20_000);

        await waitForSelector(view, "[data-profile-joined]");
        await waitForSelector(view, "[data-profile-posts]");
        await waitForSelector(view, "[data-profile-posts] [data-profile-post]", 20_000);
        expect(await withinWidth(view)).toBe(true);
      });
    }, 120_000);
  }

  test("a member edits their profile at 360px and sees it on the public page", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        const path = await seededProfilePath(view);
        await view.navigate(USER_URL);
        await loginAs(view, "member-1");

        // The server renders the save control disabled: a click before the client module has
        // attached its handler must not fall back to a native form submission and reload.
        const serverHtml = await view.evaluate<string>(
          'fetch("/account/profile", { credentials: "same-origin" }).then((response) => response.text())',
        );
        expect(serverHtml).toMatch(/<button[^>]*data-profile-save[^>]*\sdisabled/);

        await view.navigate(new URL("/account/profile", USER_URL).toString());
        await waitForSelector(view, "[data-profile-edit-page]", 20_000);
        expect(await withinWidth(view)).toBe(true);

        await setInputValue(view, "[data-profile-about]", ABOUT_TEXT);

        if (
          await view.evaluate<boolean>(
            'document.querySelector("[data-profile-custom-title]") !== null',
          )
        ) {
          await setInputValue(view, "[data-profile-custom-title]", "E2E Custom Title");
        }

        await waitForSelector(view, "[data-profile-save]:not([disabled])");
        await clickSelector(view, "[data-profile-save]");
        await waitForSelector(view, "[data-profile-saved]:not([hidden])", 20_000);

        await view.navigate(new URL(path, USER_URL).toString());
        await waitForSelector(view, "[data-profile-page]", 20_000);
        await waitForText(view, ABOUT_TEXT, 20_000);
        await waitForText(view, "E2E Custom Title", 20_000);
        await waitForExpression(
          view,
          'document.querySelector("[data-profile-about]")?.textContent?.includes("E2E profile about section") === true',
          20_000,
        );
      },
    );
  }, 180_000);
});
