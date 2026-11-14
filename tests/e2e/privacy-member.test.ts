import { describe, expect, test } from "bun:test";
import { loginAs, type ViewportName, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "mobile390", "desktop"];

integrationDescribe("member privacy pages", () => {
  for (const viewport of VIEWPORTS) {
    test(`renders the public privacy policy at ${viewport}`, async () => {
      await withPage({ url: `${USER_URL}/privacy`, viewport }, async (view) => {
        await waitForSelector(view, "[data-privacy-policy-page]");
        await waitForSelector(view, "[data-privacy-policy]");
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      });
    }, 120_000);

    test(`shows export, erasure and retained records at ${viewport}`, async () => {
      await withPage({ url: `${USER_URL}/account/privacy`, viewport }, async (view) => {
        await loginAs(view, "member-1");
        await waitForSelector(view, "[data-account-privacy]");
        await waitForSelector(view, "[data-privacy-download]");
        await waitForSelector(view, "[data-privacy-retained-entry]");
        await waitForSelector(view, "[data-privacy-export]:not([disabled])");
        await waitForSelector(view, "[data-privacy-erasure]:not([disabled])");

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      });
    }, 120_000);
  }
});
