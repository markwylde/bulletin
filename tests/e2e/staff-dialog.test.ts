import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack in development mode:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

integrationDescribe("confirmation dialog", () => {
  test("opens modally, focuses inside and closes on Escape", async () => {
    await withPage({ url: `${STAFF_URL}/dev/blocks`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, "[data-dev-dialog]");
      await clickSelector(view, "[data-open-dialog]");
      await waitForSelector(view, "[data-confirm-dialog]");

      expect(
        await view.evaluate<boolean>(`(() => {
          const dialog = document.querySelector("[data-confirm-dialog]");
          return dialog instanceof HTMLDialogElement &&
            dialog.open &&
            dialog.matches(":modal") &&
            dialog.contains(document.activeElement);
        })()`),
      ).toBe(true);

      await view.cdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
      await view.cdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });

      await waitForExpression(view, '!document.querySelector("[data-confirm-dialog]")', 20_000);
    });
  }, 120_000);
});
