import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  VIEWPORTS,
  type ViewportName,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

// Task 2.2/2.3: managing a child theme in the staff app at both required viewports.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const STAFF_URL = staffBaseUrl();
const THEMES_URL = new URL("/themes", STAFF_URL).toString();

async function createChild(view: Bun.WebView, name: string): Promise<void> {
  await view.navigate(THEMES_URL);
  await waitForSelector(view, "[data-theme-create]", 20_000);
  const parent = await view.evaluate<string | null>(`(() => {
    const select = document.querySelector("[data-theme-create-parent]");
    if (!(select instanceof HTMLSelectElement)) return null;
    const option = [...select.options].find((entry) => entry.textContent?.trim() === "default");
    if (!option) return null;
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return option.value;
  })()`);

  if (parent === null) {
    throw new Error("The seeded default theme is missing");
  }

  await setInputValue(view, "[data-theme-create-name]", name);
  await waitForSelector(view, "[data-theme-create-submit]:not([disabled])", 20_000);
  await clickSelector(view, "[data-theme-create-submit]");
  await waitForSelector(view, "[data-theme-editor]", 20_000);
}

async function selectFooter(view: Bun.WebView): Promise<void> {
  await waitForSelector(view, "[data-theme-template-select]", 20_000);
  const changed = await view.evaluate<boolean>(`(() => {
    const select = document.querySelector("[data-theme-template-select]");
    if (!(select instanceof HTMLSelectElement)) return false;
    if (![...select.options].some((option) => option.value === "footer")) return false;
    select.value = "footer";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

  if (!changed) {
    throw new Error("The footer template is missing");
  }

  await waitForExpression(
    view,
    `document.querySelector("[data-theme-template-body]")?.value?.includes("theme.footer") === true`,
    20_000,
  );
}

integrationDescribe("theme management", () => {
  for (const viewportName of ["mobile360", "desktop"] as ViewportName[]) {
    test(`edits, versions, reverts and previews a child theme at ${VIEWPORTS[viewportName].width}px`, async () => {
      const name = `e2e-theme-${viewportName}-${Date.now()}`;

      await withPage(
        {
          url: STAFF_URL,
          viewport: viewportName,
          // The validation journey deliberately asks the API for refusals.
          allowConsoleErrors: [/status of 400 .*\/api\/staff\/themes\/(template|css)/],
        },
        async (view) => {
          await loginAs(view, "admin");
          await createChild(view, name);
          const themeId = await view.evaluate<string | null>(
            'document.querySelector("[data-theme-editor]")?.getAttribute("data-theme-id") ?? null',
          );

          if (themeId === null) {
            throw new Error("The new theme id is missing");
          }

          await selectFooter(view);

          const original = await view.evaluate<string>(
            'document.querySelector("[data-theme-template-body]")?.value ?? ""',
          );
          expect(original.length).toBeGreaterThan(0);

          // The first save records the untouched parent body as version 1.
          await waitForSelector(view, "[data-theme-template-save]:not([disabled])", 20_000);
          await clickSelector(view, "[data-theme-template-save]");
          await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
          await waitForExpression(
            view,
            `[...document.querySelectorAll("[data-theme-version-select] option")].some((option) => option.value !== "")`,
            20_000,
          );

          // Save-time validation names the rejected construct.
          await setInputValue(
            view,
            "[data-theme-template-body]",
            `${original}\n<script>alert(1)</script>`,
          );
          await clickSelector(view, "[data-theme-template-save]");
          await waitForSelector(view, "[data-themes-error]", 20_000);
          const validation = await view.evaluate<string>(
            'document.querySelector("[data-themes-error]")?.textContent ?? ""',
          );
          expect(validation.toLowerCase()).toContain("script");

          // Save creates a version and the diff shows the added line.
          await setInputValue(
            view,
            "[data-theme-template-body]",
            `${original}\n<!-- saved from e2e -->`,
          );
          await waitForSelector(view, "[data-theme-template-save]:not([disabled])", 20_000);
          await clickSelector(view, "[data-theme-template-save]");
          await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
          await waitForExpression(
            view,
            `document.querySelector("[data-theme-template-body]")?.value?.includes("saved from e2e") === true`,
            20_000,
          );

          // A version from before the edit is restorable.
          await waitForExpression(
            view,
            `[...document.querySelectorAll("[data-theme-version-select] option")].some((option) => option.value !== "")`,
            20_000,
          );
          const versions = await view.evaluate<string[]>(
            `[...document.querySelectorAll("[data-theme-version-select] option")].map((option) => option.value).filter((value) => value !== "")`,
          );
          const first = versions[versions.length - 1];

          if (first === undefined) {
            throw new Error("No template version was recorded");
          }

          await view.evaluate(`(() => {
          const select = document.querySelector("[data-theme-version-select]");
          if (!(select instanceof HTMLSelectElement)) return false;
          select.value = ${JSON.stringify(first)};
          select.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`);
          await waitForSelector(view, "[data-theme-version-restore]:not([disabled])", 20_000);
          await clickSelector(view, "[data-theme-version-restore]");
          await waitForSelector(view, '[data-toast-tone="success"]', 20_000);

          // Reload the editor so the assertion reads the stored version, not local React state.
          await view.navigate(THEMES_URL);
          await waitForSelector(view, `[data-theme-edit="${themeId}"]`, 20_000);
          await clickSelector(view, `[data-theme-edit="${themeId}"]`);
          await selectFooter(view);
          await waitForExpression(
            view,
            `document.querySelector("[data-theme-template-body]")?.value?.includes("saved from e2e") === false`,
            20_000,
          );

          // Reverting to the parent removes the child override.
          await waitForSelector(view, "[data-theme-template-revert]", 20_000);
          await clickSelector(view, "[data-theme-template-revert]");
          await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
          await waitForSelector(view, "[data-theme-inherited]", 20_000);

          // The CSS filter rejects an external import and accepts local CSS.
          await clickSelector(view, '[data-theme-tab="css"]');
          await waitForSelector(view, "[data-theme-css]", 20_000);
          await setInputValue(
            view,
            "[data-theme-css]",
            '@import url("https://evil.example/x.css");',
          );
          await clickSelector(view, "[data-theme-css-save]");
          await waitForSelector(view, "[data-themes-error]", 20_000);
          expect(
            await view.evaluate<string>(
              'document.querySelector("[data-themes-error]")?.textContent ?? ""',
            ),
          ).toContain("@import");

          await setInputValue(view, "[data-theme-css]", ".e2e-brand { color: #3157c7; }");
          await waitForSelector(view, "[data-theme-css-save]:not([disabled])", 20_000);
          await clickSelector(view, "[data-theme-css-save]");
          await waitForExpression(
            view,
            'document.querySelector("[data-themes-error]") === null',
            20_000,
          );

          // Preview issues a signed link for the user origin.
          await waitForSelector(view, "[data-theme-preview]:not([disabled])", 20_000);
          await clickSelector(view, "[data-theme-preview]");
          await waitForSelector(view, "[data-theme-preview-link]", 20_000);
          const preview = await view.evaluate<string | null>(
            'document.querySelector("[data-theme-preview-link]")?.getAttribute("href") ?? null',
          );
          expect(preview).toContain("/_preview?token=");

          expect(
            await view.evaluate<number>(
              "document.documentElement.scrollWidth - document.documentElement.clientWidth",
            ),
          ).toBeLessThanOrEqual(1);
        },
      );
    }, 180_000);
  }
});
