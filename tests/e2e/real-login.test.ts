import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, waitForText, withPage } from "@bulletin/test-utils/e2e";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const APPS = [
  {
    name: "user-app",
    url: Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080",
    profile: "member-1",
    displayName: "Regular Member One",
  },
  {
    name: "staff-app",
    url: Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080",
    profile: "admin",
    displayName: "Admin",
  },
] as const;

integrationDescribe("real-browser login", () => {
  for (const app of APPS) {
    test(`${app.name} clicks Log in and reaches a signed-in state without page errors`, async () => {
      await withPage({ url: app.url, viewport: "mobile360" }, async (view) => {
        await waitForSelector(view, "[data-login]");
        await loginAs(view, app.profile);

        expect(
          await view.evaluate<string | null>(
            "document.querySelector('[data-auth-state]')?.getAttribute('data-auth-state') ?? null",
          ),
        ).toBe("authenticated");
        expect(
          await view.evaluate<boolean>(
            "document.querySelector('[data-auth-error]')?.hidden ?? true",
          ),
        ).toBe(true);
        await waitForText(view, app.displayName, 30_000);
      });
    }, 120_000);
  }
});
