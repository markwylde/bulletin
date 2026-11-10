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

// Run against a freshly seeded stack, exactly as local development starts it:
//   docker compose down -v
//   docker compose up --watch
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const FLAG = "quickReply";

function rowSelector(key: string): string {
  return `[data-table-row="${key}"], [data-card-row="${key}"]`;
}

function rowIncludes(key: string, text: string): string {
  return `[...document.querySelectorAll('${rowSelector(key)}')].some(
    (row) => (row.textContent ?? "").includes(${JSON.stringify(text)})
  )`;
}

async function waitForSeededFlags(view: Bun.WebView): Promise<void> {
  for (const key of ["newEditor", "quickReply", "compactTopicList"]) {
    await waitForSelector(view, `[data-edit-flag="${key}"]`);
  }

  // The seed covers a group-targeted flag, a percentage rollout and a flag with no rules.
  await waitForExpression(view, rowIncludes("newEditor", "On for Super moderators"));
  await waitForExpression(
    view,
    `[...document.querySelectorAll('${rowSelector("quickReply")}')].some((row) =>
      /On for \\d+% of members/.test(row.textContent ?? "")
    )`,
  );
  await waitForExpression(view, rowIncludes("compactTopicList", "No rules"));
}

async function editFlag(view: Bun.WebView): Promise<void> {
  await loginAs(view, "admin");
  await waitForSelector(view, '[data-page="flags"]');
  await waitForSeededFlags(view);
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

  test("lists flags as cards and edits rules at 390 px", async () => {
    await withPage({ url: `${STAFF_URL}/flags`, viewport: "mobile390" }, async (view) => {
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
        await view.evaluate<boolean>(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
      ).toBe(true);
    });
  }, 180_000);

  test("removes the final rule, saves the empty list and keeps it after a reload", async () => {
    await withPage({ url: `${STAFF_URL}/flags`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="flags"]');
      await waitForSelector(view, '[data-edit-flag="newEditor"]');
      await clickSelector(view, '[data-edit-flag="newEditor"]');
      await waitForSelector(view, '[data-flag-editor="newEditor"] [data-form="flag-rules"]');

      await clickSelector(view, '[data-flag-editor="newEditor"] [data-rule-remove="0"]');
      await waitForExpression(
        view,
        `!document.querySelector('[data-flag-editor="newEditor"] [data-rule-order]')`,
      );

      // The submit control must survive an empty rule list, otherwise the default cannot return.
      await waitForSelector(view, '[data-flag-editor="newEditor"] [data-form-submit]');
      expect(
        await view.evaluate<boolean>(
          `document.querySelector('[data-flag-editor="newEditor"] [data-form-submit]')?.hasAttribute("disabled") === false`,
        ),
      ).toBe(true);

      await clickSelector(view, '[data-flag-editor="newEditor"] [data-form-submit]');
      await waitForSelector(view, '[data-toast-tone="success"]');
      await waitForExpression(view, rowIncludes("newEditor", "No rules"), 20_000);
      await waitForExpression(
        view,
        `[...document.querySelectorAll("[data-flag-log-entry]")].some(
          (entry) => (entry.textContent ?? "").includes("newEditor: No rules")
        )`,
      );

      // Reloading proves the empty rule list reached the database.
      await view.navigate(`${STAFF_URL}/flags`);
      await waitForSelector(view, '[data-page="flags"]');
      await waitForExpression(view, rowIncludes("newEditor", "No rules"), 20_000);

      // Restore the seeded group rule so the suite can run again without a database reset.
      await clickSelector(view, '[data-edit-flag="newEditor"]');
      await waitForSelector(view, '[data-flag-editor="newEditor"] [data-form="flag-rules"]');
      await clickSelector(view, '[data-flag-editor="newEditor"] [data-add-rule="group"]');
      await waitForSelector(
        view,
        '[data-flag-editor="newEditor"] [data-form-field="rule-0-groups"]',
      );
      await clickSelector(
        view,
        '[data-flag-editor="newEditor"] [data-form-field="rule-0-groups"] input[value="super_moderators"]',
      );
      await clickSelector(
        view,
        '[data-flag-editor="newEditor"] [data-form-field="rule-0-value"] input',
      );
      await clickSelector(view, '[data-flag-editor="newEditor"] [data-form-submit]');
      await waitForExpression(view, rowIncludes("newEditor", "On for Super moderators"), 20_000);
    });
  }, 180_000);
});
