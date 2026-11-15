import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const e2eDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

async function personalKeyFlow(view: Bun.WebView): Promise<void> {
  await loginAs(view, "account-member");
  await view.navigate(new URL("/account/api-keys", USER_URL).toString());
  await waitForSelector(view, "[data-account-api-keys]");
  await waitForSelector(view, '[data-api-key-scope="read:forums"]');

  const label = `E2E Personal ${String(Date.now()).slice(-8)}`;
  await setInputValue(view, "[data-api-key-label]", label);
  await clickSelector(view, '[data-api-key-scope="read:topics"]');
  await clickSelector(view, "[data-api-key-submit]");
  await waitForExpression(
    view,
    `!document.querySelector("[data-api-key-secret]")?.hasAttribute("hidden") &&
      (document.querySelector("[data-api-key-secret-value]")?.textContent ?? "").startsWith("blt_")`,
    20_000,
  );
  await waitForExpression(
    view,
    `[...document.querySelectorAll("[data-api-key-row]")].some((row) =>
      (row.textContent ?? "").includes(${JSON.stringify(label)})
    )`,
    20_000,
  );

  await waitForSelector(view, "[data-api-key-row] [data-api-key-revoke]:not([disabled])");
  await view.evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-api-key-row]")].find((entry) =>
      (entry.textContent ?? "").includes(${JSON.stringify(label)})
    );
    row?.querySelector("[data-api-key-revoke]")?.click();
  })()`);
  await waitForExpression(
    view,
    `[...document.querySelectorAll("[data-api-key-row]")].some((row) =>
      (row.textContent ?? "").includes(${JSON.stringify(label)}) &&
      (row.textContent ?? "").includes("Revoked")
    )`,
    20_000,
  );

  expect(
    await view.evaluate<boolean>(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
}

async function integrationKeyFlow(view: Bun.WebView): Promise<void> {
  await loginAs(view, "admin");
  await view.navigate(new URL("/settings/api-keys", STAFF_URL).toString());
  await waitForSelector(view, '[data-page="api-keys"]');
  await waitForSelector(view, "[data-api-key-group]");

  const membersSelected = await view.evaluate<boolean>(`(() => {
    const input = [...document.querySelectorAll("[data-api-key-group]")].find((entry) =>
      (entry.closest("label")?.textContent ?? "").includes("Members")
    );
    if (!(input instanceof HTMLInputElement)) return false;
    input.click();
    return true;
  })()`);
  expect(membersSelected).toBe(true);

  const label = `E2E Bot ${String(Date.now()).slice(-8)}`;
  await setInputValue(view, "[data-api-key-label]", label);
  await clickSelector(view, "[data-api-key-create]");
  await waitForExpression(
    view,
    `!document.querySelector("[data-api-key-secret]")?.hasAttribute("hidden") &&
      (document.querySelector("[data-api-key-secret-value]")?.textContent ?? "").startsWith("blt_")`,
    20_000,
  );
  await waitForExpression(
    view,
    `[...document.querySelectorAll("[data-api-key-row]")].some((row) =>
      (row.textContent ?? "").includes(${JSON.stringify(label)})
    )`,
    20_000,
  );

  await waitForSelector(view, "[data-api-key-row] [data-api-key-revoke]:not([disabled])");
  await view.evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-api-key-row]")].find((entry) =>
      (entry.textContent ?? "").includes(${JSON.stringify(label)})
    );
    row?.querySelector("[data-api-key-revoke]")?.click();
  })()`);
  await waitForSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
  await clickSelector(view, "[data-confirm-dialog][open] [data-confirm-action]");
  await waitForExpression(
    view,
    `[...document.querySelectorAll("[data-api-key-row]")].some((row) =>
      (row.textContent ?? "").includes(${JSON.stringify(label)}) &&
      (row.textContent ?? "").includes("Revoked")
    )`,
    20_000,
  );

  expect(
    await view.evaluate<boolean>(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
}

e2eDescribe("personal API keys", () => {
  test("creates and revokes a personal key at 360 px", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, personalKeyFlow);
  }, 180_000);

  test("creates and revokes a personal key at 1440 px", async () => {
    await withPage({ url: USER_URL, viewport: "desktop" }, personalKeyFlow);
  }, 180_000);
});

e2eDescribe("integration API keys", () => {
  test("creates and revokes an integration key at 360 px", async () => {
    await withPage({ url: STAFF_URL, viewport: "mobile360" }, integrationKeyFlow);
  }, 180_000);

  test("creates and revokes an integration key at 1440 px", async () => {
    await withPage({ url: STAFF_URL, viewport: "desktop" }, integrationKeyFlow);
  }, 180_000);
});
