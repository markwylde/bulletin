import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 4.3: a new member without a display name is redirected to the step page at 360 px.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const CHOSEN_NAME = "Step Member Demo";

/** Clears the session member's display name so the test starts from a new-member state. */
async function resetDisplayName(view: Bun.WebView): Promise<void> {
  const reset = await view.evaluate<boolean>(`(async () => {
    const session = await (await fetch("/api/auth/session", {
      headers: { accept: "application/json" },
    })).json();
    const response = await fetch("/api/test/reset-display-name", {
      method: "POST",
      headers: { "x-bulletin-csrf": session.csrfToken ?? "" },
    });
    return response.ok;
  })()`);

  if (!reset) {
    throw new Error("could not reset the display name");
  }
}

integrationDescribe("display-name step", () => {
  test("redirects a new member to the step page and returns them afterwards", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      try {
        await loginAs(view, "step-member");
        await resetDisplayName(view);

        await view.navigate(USER_URL);
        await waitForSelector(view, "[data-display-name-form]", 20_000);

        expect(new URL(view.url).pathname).toBe("/display-name");
        expect(new URL(view.url).searchParams.get("return_to")).toBe("/");
        expect(
          await view.evaluate<string>(
            'fetch("/display-name", { credentials: "include" }).then((response) => response.headers.get("cache-control"))',
          ),
        ).toBe("private, no-store");

        await setInputValue(view, "[data-display-name-input]", CHOSEN_NAME);
        await clickSelector(view, "[data-display-name-submit]");

        await waitForSelector(view, "[data-display-name]", 20_000);
        expect(new URL(view.url).pathname).toBe("/");
        await waitForText(view, CHOSEN_NAME, 20_000);
      } finally {
        // Leave the seeded profile without a name for the next run.
        try {
          await view.navigate(USER_URL);
          await resetDisplayName(view);
        } catch {
          // The test already failed; the reset is best effort.
        }
      }
    });
  }, 120_000);
});
