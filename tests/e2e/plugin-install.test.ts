import { describe, expect, test } from "bun:test";
import { CSRF_STORAGE_KEY } from "@bulletin/domain/auth/browser";
import {
  clickSelector,
  loginAs,
  loginAsRefused,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// A staff marketplace install, end to end on the running stack: review, approve, plugin-host
// starts the sandbox, and the plugin's template fragment renders on the forum (ADR 0009).
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const DEMO_URL = new URL("/_demo", userBaseUrl()).toString();
const PLUGIN = "topic-notice";

/** A same-origin staff API call from the page, with the session's CSRF token. */
function staffPost(path: string, body: unknown): string {
  return `fetch(${JSON.stringify(path)}, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-bulletin-csrf": sessionStorage.getItem(${JSON.stringify(CSRF_STORAGE_KEY)}) ?? "",
    },
    body: ${JSON.stringify(JSON.stringify(body))},
  }).then((response) => response.status)`;
}

integrationDescribe("plugin marketplace install", () => {
  test("someone without the plugin permission cannot install", async () => {
    await withPage(
      {
        url: `${STAFF_URL}/plugins`,
        viewport: "mobile360",
        // The refused session and the refused install are the point of this test.
        allowConsoleErrors: [/api\/auth\/session/, /api\/staff\/plugins\/install/],
      },
      async (view) => {
        await loginAsRefused(view, "member-1");
        const status = await view.evaluate<number>(
          staffPost("/api/staff/plugins/install", {
            pluginId: PLUGIN,
            approved: true,
            capabilities: ["template"],
            egressHosts: [],
          }),
        );
        expect([401, 403]).toContain(status);
      },
    );
  }, 120_000);

  test("a staff install starts the plugin and its fragment renders on the forum", async () => {
    await withPage({ url: `${STAFF_URL}/plugins`, viewport: "desktop" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="plugins"]', 20_000);
      await waitForSelector(view, "[data-plugin-marketplace]", 20_000);

      // The stack keeps its database between runs: start from "not installed".
      const installed = await view.evaluate<boolean>(
        `Boolean(document.querySelector('[data-plugin-card="${PLUGIN}"] [data-plugin-state="active"]'))`,
      );

      if (installed) {
        expect(
          await view.evaluate<number>(
            staffPost("/api/staff/plugins/uninstall", { pluginId: PLUGIN, dataAction: "keep" }),
          ),
        ).toBe(200);
        await view.navigate(`${STAFF_URL}/plugins`);
      }

      await waitForSelector(view, `[data-plugin-review="${PLUGIN}"]:not([disabled])`, 20_000);
      await clickSelector(view, `[data-plugin-review="${PLUGIN}"]`);
      await waitForSelector(view, `[data-plugin-review-capabilities="${PLUGIN}"]`, 20_000);
      expect(
        await view.evaluate<string>(
          `document.querySelector('[data-plugin-review-capabilities="${PLUGIN}"]').innerText`,
        ),
      ).toContain("Inject template fragments");

      await clickSelector(view, `[data-plugin-install="${PLUGIN}"]:not([disabled])`);
      await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
      await waitForSelector(
        view,
        `[data-plugin-card="${PLUGIN}"] [data-plugin-state="active"]`,
        60_000,
      );
    });

    await withPage({ url: `${DEMO_URL}/2`, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-demo-topics]", 20_000);
      await waitForExpression(
        view,
        `Boolean(document.querySelector('[data-plugin-notice="${PLUGIN}"]'))`,
        30_000,
      );
    });
  }, 240_000);
});
