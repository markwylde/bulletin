import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

// Staff plugin manager and plugin settings form at 360 px (tasks 5.1/5.2).
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

integrationDescribe("staff plugin manager", () => {
  test("lists the plugin, shows capabilities/health and saves a validated setting", async () => {
    await withPage({ url: `${STAFF_URL}/plugins`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="plugins"]');
      await waitForSelector(view, '[data-plugin-card="sandbox-demo"]', 20_000);

      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-plugin-card=\"sandbox-demo\"] [data-plugin-state]').textContent",
        ),
      ).toBe("active");
      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-plugin-card=\"sandbox-demo\"] [data-plugin-capabilities]').innerText",
        ),
      ).toContain("Receive domain events");
      expect(
        await view.evaluate<string>(
          'document.querySelector("[data-plugin-timings]")?.innerText ?? ""',
        ),
      ).toContain("activationMs");
      expect(
        await view.evaluate<number>(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ),
      ).toBeLessThanOrEqual(1);

      await waitForSelector(view, '[data-plugin-configure="sandbox-demo"]:not([disabled])');
      await clickSelector(view, '[data-plugin-configure="sandbox-demo"]');
      await waitForSelector(view, '[data-plugin-detail="sandbox-demo"]');
      await waitForSelector(view, '[data-form-field="greeting"] input');

      // Empty required value is rejected client-side with a translated error.
      await setInputValue(view, '[data-form-field="greeting"] input', "");
      await clickSelector(
        view,
        '[data-form-field="greeting"] ~ * button[type="submit"], button[type="submit"]',
      );
      await waitForSelector(view, "[data-form-error]", 5_000);

      await setInputValue(view, '[data-form-field="greeting"] input', "Hello from the manager");
      await clickSelector(view, 'button[type="submit"]');
      await waitForSelector(view, '[data-toast-tone="success"]', 10_000);

      // Reloading the page shows the saved plugin value (stored in plugin_settings only).
      await view.navigate(`${STAFF_URL}/plugins`);
      await waitForSelector(view, '[data-plugin-configure="sandbox-demo"]:not([disabled])', 20_000);
      await clickSelector(view, '[data-plugin-configure="sandbox-demo"]');
      await waitForSelector(view, '[data-form-field="greeting"] input');
      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-form-field=\"greeting\"] input').value",
        ),
      ).toBe("Hello from the manager");
    });
  }, 120_000);

  test("health and error page types render in the manager", async () => {
    await withPage({ url: `${STAFF_URL}/plugins`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-plugin-configure="sandbox-demo"]:not([disabled])', 20_000);
      await clickSelector(view, '[data-plugin-configure="sandbox-demo"]');

      await clickSelector(view, '[data-plugin-tab="health"]');
      await waitForSelector(view, '[data-plugin-page="table"]');
      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-plugin-page=\"table\"]').innerText",
        ),
      ).toContain("Hook");

      await clickSelector(view, '[data-plugin-tab="errors"]');
      await waitForSelector(view, '[data-plugin-page="log"]');
      await waitForExpression(
        view,
        "document.querySelector('[data-plugin-page=\"log\"]').innerText.length > 0",
      );
    });
  }, 120_000);
});
