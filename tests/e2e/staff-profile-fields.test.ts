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

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();

integrationDescribe("staff custom profile fields", () => {
  test("opens a member's profile editor at 360 px", async () => {
    await withPage(
      { url: `${STAFF_URL}/members/profiles`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="member-profiles"]', 20_000);

        const id = await view.evaluate<string | null>(`(async () => {
          const response = await fetch("/api/staff/moderators/members?query=" + encodeURIComponent("Regular Member One"));
          const body = await response.json();
          return body.members?.[0]?.id ?? null;
        })()`);

        if (id === null) {
          throw new Error("The seeded member is missing");
        }

        await setInputValue(view, "[data-profile-member-id]", id);
        await waitForSelector(view, "[data-profile-member-load]:not([disabled])");
        await clickSelector(view, "[data-profile-member-load]");
        await waitForSelector(view, "[data-profile-display-name]", 20_000);
        await waitForExpression(
          view,
          `document.querySelector("[data-profile-display-name]")?.textContent?.includes("Regular Member One") === true`,
          20_000,
        );

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
      },
    );
  }, 180_000);

  test("creates and deletes a field at 360 px", async () => {
    await withPage(
      { url: `${STAFF_URL}/members/profile-fields`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "admin");
        await waitForSelector(view, '[data-page="profile-fields"]', 20_000);

        const stamp = Date.now();
        const label = `E2E field ${stamp}`;

        await waitForSelector(view, "[data-profile-field-new]:not([disabled])");
        await clickSelector(view, "[data-profile-field-new]");
        await waitForSelector(view, "[data-profile-field-label-en]");

        await setInputValue(view, "[data-profile-field-label-en]", label);
        await setInputValue(view, "[data-profile-field-label-es]", `Campo ${stamp}`);
        await setInputValue(view, "[data-profile-field-label-fr]", `Champ ${stamp}`);
        await waitForSelector(view, "[data-profile-field-save]:not([disabled])");
        await clickSelector(view, "[data-profile-field-save]");

        await waitForExpression(
          view,
          `[...document.querySelectorAll("[data-profile-field]")].some(
            (row) => (row.textContent ?? "").includes(${JSON.stringify(label)})
          )`,
          20_000,
        );

        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);

        const rowId = await view.evaluate<string | null>(`(() => {
          const row = [...document.querySelectorAll("[data-profile-field]")].find(
            (element) => (element.textContent ?? "").includes(${JSON.stringify(label)})
          );
          return row?.getAttribute("data-profile-field") ?? null;
        })()`);

        if (rowId === null) {
          throw new Error("The created field is missing");
        }

        await clickSelector(view, `[data-profile-field-delete="${rowId}"]`);
        await waitForSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
        await clickSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
        await waitForExpression(
          view,
          `!document.querySelector('[data-profile-field="${rowId}"]')`,
          20_000,
        );
      },
    );
  }, 180_000);
});
