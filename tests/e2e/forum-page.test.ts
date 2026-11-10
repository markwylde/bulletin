import { describe, expect, test } from "bun:test";
import { VIEWPORTS, type ViewportName, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

function forumUrl(ref: string): string {
  return new URL(`/forum/${ref}`, USER_URL).toString();
}

integrationDescribe("forum page", () => {
  for (const viewportName of VIEWPORT_NAMES) {
    const viewport = VIEWPORTS[viewportName];

    test(`renders the forum page at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
      await withPage({ url: forumUrl("2-announcements"), viewport: viewportName }, async (view) => {
        await waitForSelector(view, "[data-forum-page]", 20_000);

        expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(
          viewport.width,
        );
        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-breadcrumbs]'))"),
        ).toBe(true);
        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-rules]'))"),
        ).toBe(true);
      });
    }, 90_000);
  }

  test("remembers the rules box collapse per viewer", async () => {
    await withPage({ url: forumUrl("2-announcements"), viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-rules]", 20_000);
      expect(await view.evaluate<boolean>("document.querySelector('[data-rules]').open")).toBe(
        true,
      );

      await view.evaluate("document.querySelector('[data-rules] summary').click()");
      expect(await view.evaluate<boolean>("document.querySelector('[data-rules]').open")).toBe(
        false,
      );

      await view.navigate(forumUrl("2-announcements"));
      await waitForSelector(view, "[data-rules]", 20_000);
      expect(await view.evaluate<boolean>("document.querySelector('[data-rules]').open")).toBe(
        false,
      );
    });
  }, 90_000);

  test("prompts for the password instead of showing content", async () => {
    await withPage(
      { url: forumUrl("3-general-discussion"), viewport: "mobile360" },
      async (view) => {
        await waitForSelector(view, "[data-forum-locked]", 20_000);

        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-forum-content]'))"),
        ).toBe(false);
        expect(
          await view.evaluate<boolean>(
            "Boolean(document.querySelector('[data-forum-unlock] input[name=password]'))",
          ),
        ).toBe(true);
      },
    );
  }, 90_000);
});
