import { describe, expect, test } from "bun:test";
import {
  chooseMockProfile,
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack in development mode:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const OFFLINE_MESSAGE = "Maintenance in progress. Please come back soon.";
const OFFLINE_CONSOLE_ERROR = new RegExp(`503.*${new URL(USER_URL).host.replaceAll(".", "\\.")}`);

async function setOffline(view: Bun.WebView, offline: boolean): Promise<void> {
  await waitForSelector(view, '[data-page="board-settings"]');
  await waitForSelector(view, "[data-form]");

  const toggled = await view.evaluate<boolean>(`(() => {
    const input = document.querySelector('[data-form-field="offline"] input[type="checkbox"]');
    if (!(input instanceof HTMLInputElement)) return false;
    if (input.checked !== ${offline}) input.click();
    return true;
  })()`);

  if (!toggled) {
    throw new Error("Offline toggle not found");
  }

  if (offline) {
    await waitForSelector(view, '[data-form-field="offlineMessage"] textarea');
    await setInputValue(view, '[data-form-field="offlineMessage"] textarea', OFFLINE_MESSAGE);
  }

  await clickSelector(view, "[data-form-submit]");
  await waitForSelector(view, '[data-toast-tone="success"]');
}

integrationDescribe("board offline mode", () => {
  test("shows the offline message to guests while administrators still see the forum", async () => {
    try {
      await withPage(
        { url: `${STAFF_URL}/settings/board`, viewport: "mobile360" },
        async (view) => {
          await loginAs(view, "admin");
          await setOffline(view, true);
        },
      );

      await withPage(
        {
          url: USER_URL,
          viewport: "mobile360",
          allowConsoleErrors: [OFFLINE_CONSOLE_ERROR],
        },
        async (view) => {
          await waitForSelector(view, "[data-offline]:not([hidden])");
          await waitForText(view, OFFLINE_MESSAGE);
          expect(
            await view.evaluate<boolean>(
              "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
            ),
          ).toBe(true);
        },
      );

      await withPage(
        {
          url: USER_URL,
          viewport: "mobile360",
          allowConsoleErrors: [OFFLINE_CONSOLE_ERROR],
        },
        async (view) => {
          await waitForSelector(view, "[data-offline]:not([hidden])");
          await waitForSelector(view, "[data-offline-login]");
          await clickSelector(view, "[data-offline-login]");
          await waitForSelector(view, "[data-login-page]");
          await waitForSelector(view, "[data-login-ready]");
          await clickSelector(view, "[data-login-page] [data-login]");
          await chooseMockProfile(view, "admin");
          await waitForSelector(view, '[data-auth-state="authenticated"]', 30_000);
          expect(
            await view.evaluate<boolean>(
              "document.querySelector('[data-offline]')?.hidden === true",
            ),
          ).toBe(true);
          await waitForSelector(view, "[data-board-name]");
        },
      );
    } finally {
      await withPage(
        { url: `${STAFF_URL}/settings/board`, viewport: "mobile360" },
        async (view) => {
          await loginAs(view, "admin");
          await setOffline(view, false);
        },
      ).catch(() => undefined);
    }
  }, 180_000);

  test("fails closed when the board state request fails", async () => {
    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/api\/board/, /ERR_BLOCKED_BY_CLIENT|ERR_FAILED/],
      },
      async (view) => {
        await view.cdp("Network.enable");
        await view.cdp("Network.setBlockedURLs", { urls: ["*/api/board*"] });
        await view.navigate(USER_URL);
        await waitForSelector(view, "[data-offline]:not([hidden])");

        expect(
          await view.evaluate<boolean>("document.querySelector('[data-online]')?.hidden === true"),
        ).toBe(true);
      },
    );
  }, 120_000);
});
