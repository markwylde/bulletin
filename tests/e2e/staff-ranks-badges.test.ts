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

integrationDescribe("staff ranks and badges", () => {
  test("creates a rank and a badge at 360px", async () => {
    await withPage({ url: `${STAFF_URL}/ranks`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="ranks"]', 20_000);
      await waitForSelector(view, "[data-rank-new]:not([disabled])");
      await clickSelector(view, "[data-rank-new]");
      await waitForSelector(view, "[data-rank-label-en]");

      const stamp = Date.now();
      await setInputValue(view, "[data-rank-min-posts]", String(stamp % 10_000));
      await setInputValue(view, "[data-rank-pips]", "2");
      await setInputValue(view, "[data-rank-label-en]", `E2E rank ${stamp}`);
      await setInputValue(view, "[data-rank-label-es]", `Rango ${stamp}`);
      await setInputValue(view, "[data-rank-label-fr]", `Rang ${stamp}`);
      await clickSelector(view, "[data-rank-save]");
      await waitForExpression(
        view,
        `[...document.querySelectorAll("[data-rank]")].some((row) =>
            (row.textContent ?? "").includes(${JSON.stringify(`E2E rank ${stamp}`)})
          )`,
        20_000,
      );
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);

      const rankId = await view.evaluate<string | null>(`(() => {
          const row = [...document.querySelectorAll("[data-rank]")].find((element) =>
            (element.textContent ?? "").includes(${JSON.stringify(`E2E rank ${stamp}`)})
          );
          return row?.getAttribute("data-rank") ?? null;
        })()`);

      if (rankId === null) {
        throw new Error("The created rank is missing");
      }

      await clickSelector(view, `[data-rank-delete="${rankId}"]`);
      await waitForSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
      await clickSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
      await waitForExpression(view, `!document.querySelector('[data-rank="${rankId}"]')`, 20_000);
    });
  }, 180_000);

  test("creates a badge and awards it to a member at 360px", async () => {
    await withPage({ url: `${STAFF_URL}/badges`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="badges"]', 20_000);
      await waitForSelector(view, "[data-badge-new]:not([disabled])");
      await clickSelector(view, "[data-badge-new]");
      await waitForSelector(view, "[data-badge-key]");

      const stamp = Date.now();
      await setInputValue(view, "[data-badge-key]", `e2e_${stamp}`);
      await setInputValue(view, "[data-badge-label-en]", `E2E badge ${stamp}`);
      await setInputValue(view, "[data-badge-label-es]", `Insignia ${stamp}`);
      await setInputValue(view, "[data-badge-label-fr]", `Badge ${stamp}`);
      await setInputValue(view, "[data-badge-desc-en]", "E2E description");
      await setInputValue(view, "[data-badge-desc-es]", "Descripción E2E");
      await setInputValue(view, "[data-badge-desc-fr]", "Description E2E");
      await clickSelector(view, "[data-badge-save]");
      await waitForExpression(
        view,
        `[...document.querySelectorAll("[data-badge]")].some((row) =>
            (row.textContent ?? "").includes(${JSON.stringify(`E2E badge ${stamp}`)})
          )`,
        20_000,
      );
      expect(
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);

      const badgeId = await view.evaluate<string | null>(`(() => {
          const row = [...document.querySelectorAll("[data-badge]")].find((element) =>
            (element.textContent ?? "").includes(${JSON.stringify(`E2E badge ${stamp}`)})
          );
          return row?.getAttribute("data-badge") ?? null;
        })()`);

      if (badgeId === null) {
        throw new Error("The created badge is missing");
      }

      // A manual award is visible on the member's staff profile page.
      await view.navigate(new URL("/members/profiles", STAFF_URL).toString());
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
      await waitForSelector(view, `[data-member-badge="${badgeId}"]`, 20_000);
      await clickSelector(
        view,
        `[data-member-badge="${badgeId}"] [data-member-badge-action="award"]`,
      );
      await waitForExpression(
        view,
        `document.querySelector('[data-member-badge="${badgeId}"] [data-member-badge-action]')?.getAttribute("data-member-badge-action") === "revoke"`,
        20_000,
      );

      await view.navigate(new URL("/badges", STAFF_URL).toString());
      await waitForSelector(view, `[data-badge="${badgeId}"]`, 20_000);
      await clickSelector(view, `[data-badge-delete="${badgeId}"]`);
      await waitForSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
      await clickSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
      await waitForExpression(view, `!document.querySelector('[data-badge="${badgeId}"]')`, 20_000);
    });
  }, 240_000);
});
