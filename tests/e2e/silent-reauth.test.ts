import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const USER_URL = Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080";

integrationDescribe("silent re-auth", () => {
  test("redirects a top-level navigation through DarkAuth and returns logged in", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");

      const aged = await view.evaluate<boolean>(
        "fetch('/api/test/age-reauth', { method: 'POST', credentials: 'include' }).then((response) => response.ok)",
      );
      expect(aged).toBe(true);

      await view.navigate(`${USER_URL}/?reauth=1`);
      await waitForSelector(view, '[data-auth-state="authenticated"]', 30_000);

      expect(new URL(view.url).origin).toBe(new URL(USER_URL).origin);
      expect(new URL(view.url).pathname).toBe("/");
    });
  }, 120_000);
});
