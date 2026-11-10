import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  VIEWPORTS,
  type ViewportName,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 4.4: the language switcher (guest `bp`, member preference) and the client-side
// suggestion banner, at every viewport.
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const DEMO_URL = new URL("/_demo/1", USER_URL).toString();
const ACCOUNT_URL = new URL("/account", USER_URL).toString();

const viewportNames = Object.keys(VIEWPORTS) as ViewportName[];

async function selectLanguage(view: Bun.WebView, locale: string): Promise<void> {
  // The switcher is an island; wait for hydration before dispatching a change.
  await waitForSelector(view, 'bl-island[data-name="LanguageSwitcher"][data-hydrated="true"]');
  await view.evaluate(`(() => {
    const select = document.querySelector("[data-language-switcher] select");
    if (!(select instanceof HTMLSelectElement)) return false;
    select.value = ${JSON.stringify(locale)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

integrationDescribe("language switching", () => {
  for (const viewportName of viewportNames) {
    test(`a guest sets the bp cookie from the switcher at ${viewportName}`, async () => {
      await withPage({ url: DEMO_URL, viewport: viewportName }, async (view) => {
        // A guest never sees the member-only account link.
        expect(
          await view.evaluate<boolean>(
            "document.querySelector('[data-account-link]')?.hidden === true",
          ),
        ).toBe(true);
        await selectLanguage(view, "es");
        await waitForSelector(view, 'html[lang="es"]', 20_000);

        expect(await view.evaluate<string>("document.cookie")).toContain("bp=es.");
        expect(await view.evaluate<string>("document.documentElement.lang")).toBe("es");
        await waitForText(view, "Foro 1", 20_000);
      });
    }, 60_000);
  }

  for (const viewportName of viewportNames) {
    test(`a member saves a language preference at ${viewportName}`, async () => {
      await withPage({ url: USER_URL, viewport: viewportName }, async (view) => {
        await loginAs(view, "member-fr");
        await view.navigate(ACCOUNT_URL);
        await waitForSelector(view, "[data-account-page]");

        try {
          expect(await view.evaluate<string>("document.documentElement.lang")).toBe("fr");

          await selectLanguage(view, "es");
          await waitForSelector(view, 'html[lang="es"]', 20_000);

          // The preference is stored on the member, not in the guest cookie.
          expect(await view.evaluate<string>("document.cookie")).not.toContain("bp=es.");
        } finally {
          try {
            await view.navigate(ACCOUNT_URL);
            await waitForSelector(
              view,
              'bl-island[data-name="LanguageSwitcher"][data-hydrated="true"]',
            );

            if ((await view.evaluate<string>("document.documentElement.lang")) !== "fr") {
              await selectLanguage(view, "fr");
              await waitForSelector(view, 'html[lang="fr"]', 20_000);
            }
          } catch {
            // Best effort: restore the seeded member's language for other tests.
          }
        }
      });
    }, 120_000);
  }

  test("offers a guest the browser's language in a client-side banner", async () => {
    await withPage({ url: DEMO_URL, viewport: "mobile360" }, async (view) => {
      // Accept-Language must never change the server-rendered locale (ADR 0006); the
      // suggestion comes from the browser after hydration.
      const userAgent = await view.evaluate<string>("navigator.userAgent");
      await view.cdp("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage: "es-ES,es;q=0.9",
      });
      await view.navigate(DEMO_URL);
      await waitForSelector(view, "[data-locale-suggestion]", 20_000);

      expect(await view.evaluate<string>("document.documentElement.lang")).toBe("en");

      await clickSelector(view, "[data-locale-suggestion-accept]");
      await waitForSelector(view, 'html[lang="es"]', 20_000);

      expect(await view.evaluate<string>("document.cookie")).toContain("bp=es.");
    });
  }, 60_000);
});
