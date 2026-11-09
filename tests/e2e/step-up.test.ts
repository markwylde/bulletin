import { describe, expect, test } from "bun:test";
import { chooseMockProfile, loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const STAFF_URL = Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080";

integrationDescribe("staff step-up", () => {
  test("re-authenticates the staff member before a sensitive action", async () => {
    await withPage(
      {
        url: STAFF_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/401.*\/api\/test\/sensitive/],
      },
      async (view) => {
        await loginAs(view, "admin");

        const session = await view.evaluate<{ readonly csrfToken: string | null }>(
          "fetch('/api/auth/session', { credentials: 'include' }).then((response) => response.json())",
        );
        const aged = await view.evaluate<boolean>(
          `fetch('/api/test/age-session', { method: 'POST', credentials: 'include', headers: { 'x-bulletin-csrf': ${JSON.stringify(session.csrfToken ?? "")} } }).then((response) => response.ok)`,
        );
        expect(aged).toBe(true);

        await view.evaluate('document.querySelector("[data-sensitive]")?.click()');
        await chooseMockProfile(view, "admin");

        await waitForSelector(view, '[data-sensitive-result="ok"]', 30_000);
        expect(
          await view.evaluate<string | null>(
            "document.querySelector('[data-sensitive-result]')?.getAttribute('data-sensitive-result') ?? null",
          ),
        ).toBe("ok");
      },
    );
  }, 120_000);
});
