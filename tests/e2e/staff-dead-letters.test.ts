import { describe, expect, test } from "bun:test";
import {
  loginAs,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

integrationDescribe("staff dead letters", () => {
  for (const viewport of VIEWPORTS) {
    test(`lists dead letters at ${viewport}`, async () => {
      await withPage({ url: STAFF_URL, viewport }, async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await view.navigate(`${STAFF_URL}/system/dead-letters`);
        await waitForSelector(view, '[data-page="dead-letters"]');
        await waitForSelector(view, "[data-table]");
        await waitForSelector(view, "[data-card-view]");

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        expect(
          await view.evaluate<number>(
            'fetch("/api/staff/events/dead-letters", { credentials: "include" }).then((response) => response.status)',
          ),
        ).toBe(200);
      });
    }, 120_000);
  }

  test("hides dead letters from a member without acp.system", async () => {
    await withPage(
      {
        url: STAFF_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/api\/staff\/events\/dead-letters/],
      },
      async (view) => {
        await loginAs(view, "super-mod");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await waitForSelector(view, '[data-widget="members"]');

        expect(
          await view.evaluate<boolean>("!document.querySelector('[data-section=\"deadLetters\"]')"),
        ).toBe(true);

        const status = await view.evaluate<number>(
          'fetch("/api/staff/events/dead-letters", { credentials: "include" }).then((response) => response.status)',
        );
        expect(status).toBe(403);

        await view.navigate(`${STAFF_URL}/system/dead-letters`);
        await waitForSelector(view, "[data-not-found]");
        await waitForExpression(view, "!document.querySelector('[data-page=\"dead-letters\"]')");
      },
    );
  }, 120_000);
});
