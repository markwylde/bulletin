import { describe, expect, test } from "bun:test";
import { waitForExpression, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";
import { findTopicHref } from "./support/topic-links.ts";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

integrationDescribe("seeded attachments and avatars", () => {
  test("renders the seeded post attachments and author avatar", async () => {
    await withPage(
      { url: `${USER_URL}/forum/5-off-topic`, viewport: "mobile360" },
      async (view) => {
        // Earlier E2E runs add topics to off-topic, so the seeded topic can move to a later page.
        const href = await findTopicHref(view, "/forum/5-off-topic", "A garden update with photos");

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
