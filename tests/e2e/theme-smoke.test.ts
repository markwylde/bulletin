import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME_NAME } from "@bulletin/templates";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 1.3 / reviewer finding: a 360 px smoke render for every theme the seed installs, with
// explicit theme selection for the child and VIP themes.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();

const PAGES = [
  { path: "/", marker: "[data-board-index]", member: false },
  { path: "/forum/5-off-topic", marker: "[data-forum-page]", member: false },
  { path: "/members", marker: "[data-member-list]", member: false },
  { path: "/leaderboards", marker: "[data-leaderboards-page]", member: false },
  { path: "/search", marker: "[data-search-page]", member: false },
  { path: "/account", marker: "[data-account-page]", member: true },
  { path: "/conversations", marker: "[data-conversations-page]", member: true },
] as const;

async function selectTheme(
  view: Bun.WebView,
  scope: string,
  name: string,
  expectedVariant?: string,
): Promise<void> {
  await view.evaluate(
    `document.querySelector(${JSON.stringify(`${scope} bl-island[data-name="ThemeChooser"]`)})?.scrollIntoView({ block: "center" })`,
  );
  await waitForSelector(
    view,
    `${scope} bl-island[data-name="ThemeChooser"][data-hydrated="true"]`,
    20_000,
  );
  await waitForSelector(view, `${scope} [data-appearance-chooser]:not([hidden])`, 20_000);
  const value = await view.evaluate<string | null>(`(() => {
    const select = document.querySelector(${JSON.stringify(`${scope} [data-appearance-theme]`)});
    if (!(select instanceof HTMLSelectElement)) return null;
    const option = [...select.options].find((entry) => entry.textContent?.trim() === ${JSON.stringify(name)});
    return option?.value ?? null;
  })()`);

  if (value === null) {
    throw new Error(`Theme ${name} is not offered in ${scope}`);
  }

  await setInputValue(view, `${scope} [data-appearance-theme]`, value);
  await waitForSelector(view, `${scope} [data-appearance-save]:not([disabled])`, 20_000);
  await clickSelector(view, `${scope} [data-appearance-save]`);
  // Callers selecting a theme without a variant (the board default) wait for
  // the attribute to disappear themselves.
  if (expectedVariant !== undefined) {
    await waitForSelector(view, `[data-theme-footer]${expectedVariant}`, 20_000);
  }
}

async function checkPages(view: Bun.WebView, member: boolean, variant: string): Promise<void> {
  for (const page of PAGES.filter((entry) => entry.member === member)) {
    await view.navigate(new URL(page.path, USER_URL).toString());
    await waitForSelector(view, page.marker, 20_000);
    await waitForSelector(view, "[data-theme-header]", 20_000);
    await waitForSelector(view, `[data-theme-footer]${variant}`, 20_000);
    expect(
      await view.evaluate<number>(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth",
      ),
    ).toBeLessThanOrEqual(1);
  }
}

integrationDescribe("seed theme smoke renders", () => {
  test(`renders the ${DEFAULT_THEME_NAME} theme at 360px`, async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await checkPages(view, false, "");
      await view.navigate(USER_URL);
      await loginAs(view, "member-1");
      await checkPages(view, true, "");
    });
  }, 180_000);

  test("renders the sunset child theme at 360px for a guest", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      const defaultCss = await view.evaluate<string>(
        'fetch("/theme-css").then((response) => response.text())',
      );
      await selectTheme(view, "[data-theme-footer]", "sunset", '[data-theme-variant="sunset"]');
      await waitForSelector(view, '[data-theme-footer][data-theme-variant="sunset"]', 20_000);
      const sunset = await view.evaluate<string>(`fetch("/theme-css").then(async (response) => {
        return response.headers.get("cache-control") + "|" + (await response.text());
      })`);
      expect(sunset).toContain("max-age=0");
      expect(sunset).toContain("border-block-start-color");
      expect(sunset).not.toBe(defaultCss);
      expect(
        await view.evaluate<string>(
          'getComputedStyle(document.querySelector("[data-theme-footer]")).borderTopColor',
        ),
      ).toMatch(/^rgb\(91, 63, 168\)|rgb\(196, 181, 253\)$/);
      await checkPages(view, false, '[data-theme-variant="sunset"]');

      // The seeded footer keeps the chooser: switch back to the board default.
      await selectTheme(view, "[data-theme-footer]", "default");
      await waitForExpression(
        view,
        'document.querySelector("[data-theme-footer]")?.hasAttribute("data-theme-variant") === false',
        20_000,
      );
    });
  }, 180_000);

  test("renders the VIP theme for a VIP member at 360px", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "vip-member");
      await view.navigate(new URL("/account", USER_URL).toString());
      await selectTheme(
        view,
        "[data-appearance-settings]",
        "vip-gold",
        '[data-theme-variant="vip"]',
      );
      await waitForSelector(view, '[data-theme-footer][data-theme-variant="vip"]', 20_000);
      await checkPages(view, false, '[data-theme-variant="vip"]');
      await checkPages(view, true, '[data-theme-variant="vip"]');
    });
  }, 180_000);
});
