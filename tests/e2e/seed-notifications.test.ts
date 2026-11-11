import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 5.2: a fresh `docker compose up --watch` must show seeded notifications and follows.
// member-es is used only here, so its seeded unread entry survives repeated E2E runs.

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

integrationDescribe("seeded notifications", () => {
  test("shows the bell count and the localised notification list", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-es");
      await waitForSelector(view, '[data-overlay-count="notifications"]:not([hidden])', 20_000);

      const count = await view.evaluate<string>(
        'document.querySelector(\'[data-overlay-count="notifications"]\')?.textContent ?? ""',
      );
      expect(Number(count)).toBeGreaterThan(0);

      await view.navigate(new URL("/account/notifications", USER_URL).toString());
      await waitForSelector(view, "[data-notifications-page]");
      await waitForSelector(view, "[data-notification-row]");

      expect(await view.evaluate<string>("document.documentElement.lang")).toBe("es");
      const text = await view.evaluate<string>("document.body.innerText");
      expect(text).toContain("respuestas nuevas");

      await view.navigate(new URL("/account/follows", USER_URL).toString());
      await waitForSelector(view, "[data-follows-page]");
      expect(
        await view.evaluate<number>('document.querySelectorAll("[data-follow-row]").length'),
      ).toBeGreaterThan(0);
    });
  }, 120_000);
});
