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

function forumUrl(): string {
  return new URL("/forum/5-off-topic", USER_URL).toString();
}

integrationDescribe("topic list and topic view", () => {
  for (const viewportName of VIEWPORT_NAMES) {
    const viewport = VIEWPORTS[viewportName];

    test(`lists and opens a topic at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
      await withPage({ url: forumUrl(), viewport: viewportName }, async (view) => {
        await waitForSelector(view, "[data-topic-list]", 20_000);

        expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(
          viewport.width,
        );
        expect(
          await view.evaluate<number>(
            "document.querySelectorAll('[data-topic-list] [data-topic-row]').length",
          ),
        ).toBeGreaterThan(0);
        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);

        const href = await view.evaluate<string | null>(
          'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
        );

        expect(href).toMatch(/^\/topic\/\d+-/);

        if (href === null) {
          throw new Error("Missing topic link");
        }

        await view.navigate(new URL(href, USER_URL).toString());
        await waitForSelector(view, "[data-topic-page]", 20_000);

        expect(
          await view.evaluate<number>(
            "document.querySelectorAll('[data-post-list] [data-post]').length",
          ),
        ).toBeGreaterThan(0);
        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-member-card]'))"),
        ).toBe(true);
        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-topic-views]'))"),
        ).toBe(true);
        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);
      });
    }, 90_000);
  }
});
