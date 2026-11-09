import { describe, expect, test } from "bun:test";
import { loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

// Run against a freshly seeded stack:
//   docker compose down -v
//   docker compose up -d --build
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

integrationDescribe("seeded staff dashboard", () => {
  test("shows member stats, recent admin actions and health after the first start", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-widget="members"]');
      await waitForSelector(view, '[data-widget="log"] [data-log-entry]');
      await waitForSelector(view, '[data-health-status="ok"]');

      const totals = await view.evaluate<string[]>(
        `[...document.querySelectorAll('[data-widget-body="members"] dd')].map((element) => element.textContent ?? "")`,
      );
      expect(totals.length).toBeGreaterThan(0);
      expect(Number(totals[0]?.replace(/\\D/g, ""))).toBeGreaterThan(0);

      const entries = await view.evaluate<number>(
        "document.querySelectorAll('[data-widget=\"log\"] [data-log-entry]').length",
      );
      expect(entries).toBeGreaterThan(0);

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 120_000);
});
