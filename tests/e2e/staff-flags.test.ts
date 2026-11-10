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

// Run against a freshly seeded stack:
//   docker compose down -v
//   docker compose up -d --build
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const FLAG = "quickReply";

async function editFlag(view: Bun.WebView): Promise<void> {
  await loginAs(view, "admin");
  await waitForSelector(view, '[data-page="flags"]');
  await waitForSelector(view, `[data-edit-flag="${FLAG}"]`);

  // The seeded fully-on flag from over 90 days ago is highlighted for removal.
  await waitForSelector(view, '[data-flag-stale="compactTopicList"]');
  await waitForSelector(view, `[data-flag-live="${FLAG}"]`);

  await clickSelector(view, `[data-edit-flag="${FLAG}"]`);
  await waitForSelector(view, `[data-flag-editor="${FLAG}"] [data-form="flag-rules"]`);

  // The shared form renderer edits the ordered percentage rule.
  await setInputValue(
    view,
    `[data-flag-editor="${FLAG}"] [data-form-field="rule-0-percent"] input`,
    "60",
  );
  await clickSelector(view, `[data-flag-editor="${FLAG}"] [data-form-submit]`);
  await waitForSelector(view, '[data-toast-tone="success"]');

  // The list re-renders with the new rule, in the table or the mobile card.
  await waitForExpression(
    view,
    `[...document.querySelectorAll('[data-table-row="${FLAG}"], [data-card-row="${FLAG}"]')].some(
      (row) => (row.textContent ?? "").includes("On for 60% of members")
    )`,
    20_000,
  );

  // The change history carries the rule change with its before and after rules.
  await waitForSelector(view, "[data-flag-log-entry]");
  await waitForExpression(
    view,
    `[...document.querySelectorAll('[data-flag-log-entry]')].some(
      (entry) => (entry.textContent ?? "").includes("${FLAG}: On for 60% of members")
    )`,
  );

  expect(
    await view.evaluate<boolean>(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
}

integrationDescribe("staff feature flags", () => {
  test("lists flags as cards, highlights stale ones and edits rules at 360 px", async () => {
    await withPage({ url: `${STAFF_URL}/flags`, viewport: "mobile360" }, async (view) => {
      await editFlag(view);

      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-card-view]")).display',
        ),
      ).toBe("flex");
      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-table-view]")).display',
        ),
      ).toBe("none");
      expect(
        await view.evaluate<number>(
          'document.querySelectorAll("[data-card-view] [data-card-row]").length',
        ),
      ).toBeGreaterThan(2);
    });
  }, 180_000);

  test("lists flags as a table and edits rules at 1440 px", async () => {
    await withPage({ url: `${STAFF_URL}/flags`, viewport: "desktop" }, async (view) => {
      await editFlag(view);

      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-table-view]")).display',
        ),
      ).not.toBe("none");
      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-card-view]")).display',
        ),
      ).toBe("none");
      expect(
        await view.evaluate<number>(
          'document.querySelectorAll("[data-table-view] [data-table-row]").length',
        ),
      ).toBeGreaterThan(2);
    });
  }, 180_000);
});
