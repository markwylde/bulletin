import { describe, expect, test } from "bun:test";
import {
  loginAs,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080";
const VIEWPORTS: readonly ViewportName[] = ["mobile360", "mobile390", "desktop"];

async function selectControl(view: Bun.WebView, selector: string, value: string): Promise<void> {
  const selected = await view.evaluate<boolean>(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!select) return false;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

  if (!selected) {
    throw new Error(`Control ${selector} not found`);
  }
}

integrationDescribe("staff console shell", () => {
  for (const viewport of VIEWPORTS) {
    test(`navigates and switches colour mode at ${viewport}`, async () => {
      await withPage({ url: STAFF_URL, viewport }, async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await waitForSelector(view, "[data-signed-in]");
        await waitForSelector(view, '[data-widget="members"]');

        const mobile = viewport !== "desktop";

        if (mobile) {
          expect(
            await view.evaluate<boolean>(
              "getComputedStyle(document.querySelector('[data-nav]')).display === 'none'",
            ),
          ).toBe(true);

          await view.evaluate('document.querySelector("[data-menu-toggle]")?.click()');
          await waitForExpression(
            view,
            "document.querySelector('[data-nav]').getAttribute('data-open') === 'true'",
          );
          expect(
            await view.evaluate<boolean>(
              "getComputedStyle(document.querySelector('[data-nav]')).display !== 'none'",
            ),
          ).toBe(true);

          await view.evaluate('document.querySelector("[data-nav] a")?.click()');
          await waitForExpression(
            view,
            "document.querySelector('[data-nav]').getAttribute('data-open') === 'false'",
          );
        } else {
          expect(
            await view.evaluate<boolean>(
              "getComputedStyle(document.querySelector('[data-nav]')).display !== 'none'",
            ),
          ).toBe(true);
          expect(
            await view.evaluate<boolean>(
              "getComputedStyle(document.querySelector('[data-menu-toggle]')).display === 'none'",
            ),
          ).toBe(true);
        }

        await selectControl(view, "[data-scheme-switch]", "dark");
        await waitForExpression(view, "document.documentElement.dataset.scheme === 'dark'", 20_000);
        expect(await view.evaluate<string>("document.documentElement.dataset.scheme")).toBe("dark");

        await selectControl(view, "[data-scheme-switch]", "light");
        await waitForExpression(
          view,
          "document.documentElement.dataset.scheme === 'light'",
          20_000,
        );

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        await selectControl(view, "[data-scheme-switch]", "system");
        await waitForExpression(
          view,
          "document.documentElement.dataset.scheme === 'system'",
          20_000,
        );
      });
    }, 120_000);
  }

  test("remembers the colour mode on another device", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      await selectControl(view, "[data-scheme-switch]", "dark");
      await waitForExpression(view, "document.documentElement.dataset.scheme === 'dark'", 20_000);
    });

    await withPage({ url: STAFF_URL, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      await waitForExpression(view, "document.documentElement.dataset.scheme === 'dark'", 20_000);

      await selectControl(view, "[data-scheme-switch]", "system");
      await waitForExpression(view, "document.documentElement.dataset.scheme === 'system'", 20_000);
    });
  }, 180_000);

  test("switches the staff language and remembers it", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      await selectControl(view, "[data-locale-switch]", "es");
      await waitForExpression(view, "document.documentElement.lang === 'es'", 20_000);

      await selectControl(view, "[data-locale-switch]", "en");
      await waitForExpression(view, "document.documentElement.lang === 'en'", 20_000);
    });
  }, 120_000);
});

integrationDescribe("staff dashboard permissions", () => {
  test("hides admin-only widgets from a super moderator", async () => {
    await withPage(
      {
        url: STAFF_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/api\/staff\/dashboard\/(log|health)/],
      },
      async (view) => {
        await loginAs(view, "super-mod");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        await waitForSelector(view, '[data-widget="members"]');

        expect(
          await view.evaluate<boolean>("Boolean(document.querySelector('[data-widget=\"log\"]'))"),
        ).toBe(false);
        expect(
          await view.evaluate<boolean>(
            "Boolean(document.querySelector('[data-widget=\"health\"]'))",
          ),
        ).toBe(false);

        const statuses = await view.evaluate<number[]>(`Promise.all([
        fetch("/api/staff/dashboard/log", { credentials: "include" }).then((response) => response.status),
        fetch("/api/staff/dashboard/health", { credentials: "include" }).then((response) => response.status)
      ])`);

        expect(statuses).toEqual([403, 403]);
      },
    );
  }, 120_000);

  test("shows member stats, the admin log and system health to an administrator", async () => {
    await withPage({ url: STAFF_URL, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      await waitForSelector(view, '[data-widget="members"]');
      await waitForSelector(view, '[data-widget="log"]');
      await waitForSelector(view, '[data-widget="health"]');
      await waitForSelector(view, '[data-health-status="ok"]');
    });
  }, 120_000);
});
