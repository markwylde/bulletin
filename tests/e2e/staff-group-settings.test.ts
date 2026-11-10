import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const CELL = '[data-setting-cell="members:posting.flood_control_seconds"]';
const SAVE = '[data-setting-save="members:posting.flood_control_seconds"]';

integrationDescribe("staff group settings", () => {
  test("edits a matrix cell and keeps it after a reload", async () => {
    await withPage({ url: `${STAFF_URL}/groups/settings`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="group-settings"]');
      await waitForSelector(view, CELL, 20_000);

      await setInputValue(view, CELL, "20");
      await clickSelector(view, SAVE);
      await waitForSelector(view, '[data-toast-tone="success"]');

      await view.navigate(`${STAFF_URL}/groups/settings`);
      await waitForSelector(view, '[data-page="group-settings"]');
      await waitForSelector(view, CELL, 20_000);
      expect(
        await view.evaluate<string>(`document.querySelector(${JSON.stringify(CELL)}).value`),
      ).toBe("20");

      // Restore the seeded default so the suite can run again without a reset.
      await setInputValue(view, CELL, "15");
      await clickSelector(view, SAVE);
      await waitForSelector(view, '[data-toast-tone="success"]');

      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 180_000);
});
