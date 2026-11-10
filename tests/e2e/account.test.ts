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

// Task 4.3: the account page over the template stack at 360 px.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const ACCOUNT_URL = new URL("/account", USER_URL).toString();

integrationDescribe("account page", () => {
  test("shows the profile, name history, sessions and language at 360 px", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "account-member");
      await view.navigate(ACCOUNT_URL);
      await waitForSelector(view, "[data-account-page]");

      // Private and uncached (ADR 0006).
      expect(
        await view.evaluate<string>(
          'fetch("/account", { credentials: "include" }).then((response) => response.headers.get("cache-control"))',
        ),
      ).toBe("private, no-store");

      const initialName = await view.evaluate<string>(
        'document.querySelector("[data-account-name-input]").value',
      );

      // The test is rerunnable: the profile starts as "Account Member" and keeps the new
      // name after the first run.
      expect(["Account Member", "Account Member Two"]).toContain(initialName);
      expect(
        await view.evaluate<number>('document.querySelectorAll("[data-language-switcher]").length'),
      ).toBeGreaterThanOrEqual(2);

      // Change the name; the page reloads with the new name and one more history entry.
      if (initialName !== "Account Member Two") {
        await setInputValue(view, "[data-account-name-input]", "Account Member Two");
        await clickSelector(view, "[data-account-name-submit]");
        await waitForExpression(
          view,
          'document.querySelector("[data-account-name-input]")?.value === "Account Member Two"',
          20_000,
        );
      }

      await waitForSelector(view, "[data-account-history-entry]", 20_000);
      expect(
        await view.evaluate<string>('document.querySelector("[data-account-name-input]").value'),
      ).toBe("Account Member Two");
      expect(
        await view.evaluate<string>('document.querySelector("[data-account-history]").innerText'),
      ).toContain("Account Member Two");

      // The active sessions list comes from the audited own-data endpoint.
      await waitForSelector(view, '[data-current-session="true"]', 20_000);
      expect(
        await view.evaluate<string>(
          'document.querySelector("[data-account-session-list]").innerText',
        ),
      ).toContain("This device");
    });
  }, 120_000);
});
