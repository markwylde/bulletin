import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const USER_URL = userBaseUrl();

integrationDescribe("staff privacy tools", () => {
  test("rejects a data request at 360 px", async () => {
    const requestId = await (async () => {
      let created = "";

      await withPage({ url: `${USER_URL}/account`, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "member-1");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        created = await view.evaluate<string>(`(async () => {
          const session = await fetch("/api/auth/session", {
            headers: { accept: "application/json" }
          }).then((response) => response.json());
          const response = await fetch("/api/me/data-erasure", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-bulletin-csrf": session.csrfToken
            },
            body: "{}"
          });
          if (response.status !== 202) throw new Error("request failed " + response.status);
          return (await response.json()).requestId;
        })()`);
      });

      return created;
    })();

    expect(requestId).toMatch(/^\d+$/);

    await withPage(
      { url: `${STAFF_URL}/privacy/requests`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="privacy-requests"]');
        await waitForSelector(view, '[data-request-due="soon"]');
        await waitForSelector(view, `[data-card-row="${requestId}"]`);

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        await setInputValue(
          view,
          `[data-card-row="${requestId}"] [data-request-reason="${requestId}"]`,
          "E2E rejection",
        );
        await waitForSelector(
          view,
          `[data-card-row="${requestId}"] [data-request-reject="${requestId}"]:not([disabled])`,
        );
        await clickSelector(
          view,
          `[data-card-row="${requestId}"] [data-request-reject="${requestId}"]`,
        );
        await waitForSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
        await clickSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
        await waitForSelector(view, '[data-toast-tone="success"]');
        await waitForSelector(
          view,
          `[data-card-row="${requestId}"] [data-request-status="rejected"]`,
          20_000,
        );
      },
    );
  }, 120_000);

  test("renders the PII access log at 360 px and hides it from staff without privacy.audit", async () => {
    await withPage(
      { url: `${STAFF_URL}/privacy/access-log`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="privacy-access-log"]');
        await waitForSelector(view, "[data-table]");
        await waitForSelector(view, "[data-card-view]");

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        expect(
          await view.evaluate<number>(
            'fetch("/api/staff/privacy/access-log", { credentials: "include" }).then((response) => response.status)',
          ),
        ).toBe(200);
      },
    );

    await withPage(
      {
        url: STAFF_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/403.*\/api\/staff\/privacy\/access-log/],
      },
      async (view) => {
        await loginAs(view, "super-mod");
        await waitForSelector(view, '[data-auth-state="authenticated"]');

        expect(
          await view.evaluate<boolean>(
            "!document.querySelector('[data-section=\"privacyAudit\"]')",
          ),
        ).toBe(true);

        expect(
          await view.evaluate<number>(
            'fetch("/api/staff/privacy/access-log", { credentials: "include" }).then((response) => response.status)',
          ),
        ).toBe(403);
      },
    );
  }, 120_000);
});
