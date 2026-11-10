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

integrationDescribe("staff emoticon sets", () => {
  test("creates a set and stays within 360 px", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await view.navigate(new URL("/settings/emoticons", STAFF_URL).toString());
      await waitForSelector(view, '[data-page="emoticons"]');
      await waitForSelector(view, "[data-emoticon-set-list]");

      expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(360);
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);

      await setInputValue(view, '[data-emoticon-set-field="key"]', "e2e");
      await setInputValue(view, '[data-emoticon-set-field="title"]', "E2E set");
      await clickSelector(view, "[data-emoticon-set-save]");
      await waitForSelector(view, "[data-emoticon-set]", 20_000);

      expect(await view.evaluate<boolean>('document.body.innerText.includes("E2E set")')).toBe(
        true,
      );
    });
  }, 180_000);
});
