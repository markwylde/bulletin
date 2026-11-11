import { describe, expect, test } from "bun:test";
import { waitForExpression, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

integrationDescribe("seeded attachments and avatars", () => {
  test("renders the seeded post attachments and author avatar", async () => {
    await withPage(
      { url: `${USER_URL}/forum/5-off-topic`, viewport: "mobile360" },
      async (view) => {
        await waitForSelector(view, "[data-topic-list]", 20_000);
        const href = await view.evaluate<string | null>(`(() => {
        const link = [...document.querySelectorAll("[data-topic-link]")].find(
          (element) => element.textContent?.includes("A garden update with photos"),
        );
        return link?.getAttribute("href") ?? null;
      })()`);

        if (href === null) {
          throw new Error("Missing the seeded attachment topic");
        }

        await view.navigate(new URL(href, USER_URL).toString());
        await waitForSelector(view, "[data-post-body] img[src^='/attachments/']", 20_000);
        await waitForSelector(view, "[data-post-attachments]", 20_000);
        await waitForSelector(view, "[data-member-avatar]", 20_000);
        await waitForExpression(
          view,
          'document.querySelector("[data-post-attachments]")?.textContent?.includes("garden-notes.txt") === true',
          10_000,
        );

        expect(
          await view.evaluate<number>(
            "document.documentElement.scrollWidth - document.documentElement.clientWidth",
          ),
        ).toBeLessThanOrEqual(1);
      },
    );
  }, 120_000);
});
