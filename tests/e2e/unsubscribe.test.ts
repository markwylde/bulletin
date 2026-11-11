import { describe, expect, test } from "bun:test";
import { type ViewportName, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 6.2: the unsubscribe pages are public, token-driven and must never act on a GET.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

integrationDescribe("unsubscribe pages", () => {
  for (const viewport of VIEWPORTS) {
    test(`shows the invalid-link page at ${viewport}`, async () => {
      await withPage(
        { url: new URL("/unsubscribe", USER_URL).toString(), viewport },
        async (view) => {
          await waitForSelector(view, "[data-unsubscribe-page]");
          expect(
            await view.evaluate<string>(
              'document.querySelector("[data-unsubscribe-page]")?.getAttribute("data-unsubscribe-state") ?? ""',
            ),
          ).toBe("invalid");
          expect(
            await view.evaluate<boolean>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1",
            ),
          ).toBe(true);
        },
      );
    }, 120_000);
  }

  test("shows the confirmed page", async () => {
    await withPage(
      { url: new URL("/unsubscribe/confirmed", USER_URL).toString(), viewport: "mobile360" },
      async (view) => {
        await waitForSelector(view, "[data-unsubscribe-page]");
        expect(
          await view.evaluate<string>(
            'document.querySelector("[data-unsubscribe-page]")?.getAttribute("data-unsubscribe-state") ?? ""',
          ),
        ).toBe("confirmed");
      },
    );
  }, 120_000);
});
