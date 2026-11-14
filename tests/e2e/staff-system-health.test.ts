import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";
import { composeSql } from "./support/database.ts";

// Run against the full stack:
//   docker compose up -d --build --wait
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "desktop"];

integrationDescribe("staff system health panel (ADR 0020)", () => {
  for (const viewport of VIEWPORTS) {
    test(`shows every service and panel section at ${viewport}`, async () => {
      await withPage({ url: STAFF_URL, viewport }, async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await view.navigate(`${STAFF_URL}/system/health`);
        await waitForSelector(view, '[data-page="system-health"]');
        await waitForSelector(view, "[data-health-status]");

        for (const section of ["services", "queues", "cache", "pools", "plugins"]) {
          await waitForSelector(view, `[data-health-section="${section}"]`);
        }

        // Every service on the internal network answers its readiness probe.
        for (const service of ["staff-api", "user-app", "user-api", "workers", "plugin-host"]) {
          await waitForSelector(view, `[data-health-service="${service}"][data-health-ok="true"]`);
        }

        // The pools come from each service's internal /metrics endpoint.
        await waitForSelector(view, '[data-pool="user-api"]');

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      });
    }, 120_000);
  }

  for (const viewport of VIEWPORTS) {
    test(`lists missing files after a restore at ${viewport}`, async () => {
      await withPage({ url: STAFF_URL, viewport }, async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await view.navigate(`${STAFF_URL}/system/missing-objects`);
        await waitForSelector(view, '[data-page="missing-objects"]');
        await waitForSelector(view, "[data-missing-last-run]");
        await waitForSelector(view, "[data-missing-total]");

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      });
    }, 120_000);
  }

  test("loads missing files beyond the first API page at 360px", async () => {
    // More rows than one 200-row API page, under keys no real object uses; removed afterwards.
    await composeSql(`
      INSERT INTO core.missing_objects (kind, resource_id, storage_key)
      SELECT 'avatar', n, 'av/e2e-missing-page/' || n
      FROM generate_series(1, 230) AS n
      ON CONFLICT DO NOTHING
    `);

    try {
      await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await view.navigate(`${STAFF_URL}/system/missing-objects`);
        await waitForSelector(view, "[data-missing-total]");
        const total = Number(
          await view.evaluate<string>(
            'document.querySelector("[data-missing-total]")?.getAttribute("data-missing-total") ?? "0"',
          ),
        );
        expect(total).toBeGreaterThanOrEqual(230);
        await waitForSelector(view, '[data-table][data-page-count="8"]');

        while (
          await view.evaluate<boolean>(
            'document.querySelector("[data-missing-load-more]") !== null',
          )
        ) {
          await waitForSelector(view, "[data-missing-load-more]:not([disabled])");
          await clickSelector(view, "[data-missing-load-more]");
          await Bun.sleep(250);
        }

        await waitForSelector(
          view,
          `[data-table][data-page-count="${Math.ceil(total / 25)}"]`,
          20_000,
        );
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      });
    } finally {
      await composeSql(
        "DELETE FROM core.missing_objects WHERE storage_key LIKE 'av/e2e-missing-page/%'",
      );
    }
  }, 120_000);

  test("hides the panel from a member without acp.system", async () => {
    await withPage(
      {
        url: STAFF_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/api\/staff\/system\/(health|missing-objects)/],
      },
      async (view) => {
        await loginAs(view, "super-mod");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await waitForSelector(view, '[data-widget="members"]');

        expect(
          await view.evaluate<boolean>(
            "!document.querySelector('[data-section=\"systemHealth\"]')",
          ),
        ).toBe(true);
        expect(
          await view.evaluate<number>(
            'fetch("/api/staff/system/health", { credentials: "include" }).then((response) => response.status)',
          ),
        ).toBe(403);

        await view.navigate(`${STAFF_URL}/system/health`);
        await waitForSelector(view, "[data-not-found]");
        await waitForExpression(view, "!document.querySelector('[data-page=\"system-health\"]')");

        expect(
          await view.evaluate<number>(
            'fetch("/api/staff/system/missing-objects", { credentials: "include" }).then((response) => response.status)',
          ),
        ).toBe(403);
        await view.navigate(`${STAFF_URL}/system/missing-objects`);
        await waitForSelector(view, "[data-not-found]");
        await waitForExpression(view, "!document.querySelector('[data-page=\"missing-objects\"]')");
      },
    );
  }, 120_000);
});
