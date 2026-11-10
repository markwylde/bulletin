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

function cardRow(key: string): string {
  return `[data-card-row="${key}"]`;
}

async function groupFlow(view: Bun.WebView): Promise<void> {
  await loginAs(view, "admin");
  await waitForSelector(view, '[data-page="groups"]');
  await waitForExpression(
    view,
    `Boolean(document.querySelector('[data-table-row="administrators"], [data-card-row="administrators"]'))`,
    20_000,
  );

  const stamp = Date.now();
  const key = `e2e_group_${stamp}`;
  const title = `E2E Group ${stamp}`;

  await setInputValue(view, '[data-group-field="key"]', key);
  await setInputValue(view, '[data-group-field="title"]', title);
  await setInputValue(view, '[data-group-field="order"]', "200");
  await clickSelector(view, "[data-group-create-submit]");
  await waitForSelector(view, `${cardRow(key)}, [data-table-row="${key}"]`, 20_000);

  await clickSelector(view, `[data-group-edit="${key}"]`);
  await waitForSelector(view, `[data-group-editor="${key}"]`);
  await setInputValue(view, '[data-group-edit-field="title"]', `${title} renamed`);
  await clickSelector(view, "[data-group-save]");
  await waitForExpression(
    view,
    `[...document.querySelectorAll('${cardRow(key)}, [data-table-row="${key}"]')].some(
      (row) => (row.textContent ?? "").includes(${JSON.stringify(`${title} renamed`)})
    )`,
    20_000,
  );

  await clickSelector(view, "[data-group-delete]");
  await waitForExpression(
    view,
    `!document.querySelector('${cardRow(key)}, [data-table-row="${key}"]')`,
    20_000,
  );

  expect(
    await view.evaluate<boolean>(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
}

integrationDescribe("staff groups", () => {
  test("creates, edits and deletes a group at 360 px", async () => {
    await withPage({ url: `${STAFF_URL}/groups`, viewport: "mobile360" }, async (view) => {
      await groupFlow(view);
      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-card-view]")).display',
        ),
      ).not.toBe("none");
    });
  }, 180_000);

  test("creates, edits and deletes a group at 1440 px", async () => {
    await withPage({ url: `${STAFF_URL}/groups`, viewport: "desktop" }, async (view) => {
      await groupFlow(view);
      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-table-view]")).display',
        ),
      ).not.toBe("none");
    });
  }, 180_000);
});
