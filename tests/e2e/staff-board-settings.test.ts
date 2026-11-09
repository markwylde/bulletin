import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";

// Run against the full stack in development mode:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080";
const STAFF_URL = Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080";
const OFFLINE_MESSAGE = "Maintenance in progress. Please come back soon.";

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

      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await waitForSelector(view, "[data-offline]:not([hidden])");
        await waitForText(view, OFFLINE_MESSAGE);
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      });

      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await waitForSelector(view, "[data-offline]:not([hidden])");
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-auth-state="authenticated"]');
        expect(
          await view.evaluate<boolean>("document.querySelector('[data-offline]')?.hidden === true"),
        ).toBe(true);
        await waitForSelector(view, "[data-board-name]");
      });
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
});
