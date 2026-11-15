import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// Run against the full stack in development mode:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

interface FetchPaused {
  readonly requestId: string;
}

async function boardDescription(view: Bun.WebView): Promise<string> {
  return view.evaluate<string>(
    "fetch('/api/board', { credentials: 'include' }).then((response) => response.json()).then((body) => body.boardDescription)",
  );
}

async function setDefaultLocale(locale: "en" | "es"): Promise<void> {
  await withPage({ url: `${STAFF_URL}/settings/board`, viewport: "mobile360" }, async (view) => {
    await loginAs(view, "admin");
    await waitForSelector(view, "[data-form]");
    await waitForExpression(
      view,
      "document.querySelector('[data-form-field=\"defaultLocale\"] select')?.value.length > 0",
    );
    await setInputValue(view, '[data-form-field="defaultLocale"] select', locale);
    await clickSelector(view, "[data-form-submit]");
    await waitForSelector(view, '[data-toast-tone="success"]');
  });
}

integrationDescribe("board state and translations", () => {
  test("keeps configured content when the board loads before the member session", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      const description = await boardDescription(view);

      let pausedResolve: ((requestId: string) => void) | undefined;
      const paused = new Promise<string>((resolve) => {
        pausedResolve = resolve;
      });
      view.addEventListener<FetchPaused>("Fetch.requestPaused", (event) => {
        pausedResolve?.(event.data.requestId);
      });
      await view.cdp("Fetch.enable", {
        patterns: [{ urlPattern: "*/api/auth/session*", requestStage: "Request" }],
      });

      await view.navigate(USER_URL);
      const requestId = await paused;
      await waitForText(view, description, 20_000);
      await view.cdp("Fetch.continueRequest", { requestId });
      await waitForSelector(view, '[data-auth-state="authenticated"]');

      expect(await view.evaluate<string>("document.body.innerText")).toContain(description);
      expect(await view.evaluate<string>("document.body.innerText")).not.toContain(
        "The Bulletin community is being prepared.",
      );
    });
  }, 120_000);

  test("keeps configured content when the member session loads before the board", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      const description = await boardDescription(view);

      let pausedResolve: ((requestId: string) => void) | undefined;
      const paused = new Promise<string>((resolve) => {
        pausedResolve = resolve;
      });
      view.addEventListener<FetchPaused>("Fetch.requestPaused", (event) => {
        pausedResolve?.(event.data.requestId);
      });
      await view.cdp("Fetch.enable", {
        patterns: [{ urlPattern: "*/api/board*", requestStage: "Request" }],
      });

      await view.navigate(USER_URL);
      const requestId = await paused;
      await waitForSelector(view, '[data-auth-state="authenticated"]');
      await view.cdp("Fetch.continueRequest", { requestId });
      await waitForText(view, description, 20_000);

      expect(await view.evaluate<string>("document.body.innerText")).toContain(description);
    });
  }, 120_000);

  test("uses the board default locale for guests while member preference wins", async () => {
    try {
      await setDefaultLocale("es");

      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await waitForText(view, "Iniciar sesión", 20_000);
        expect(await view.evaluate<string>("document.documentElement.lang")).toBe("es");
      });

      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "member-fr");
        // The logout button sits in the closed account menu, so read its text directly.
        await waitForExpression(
          view,
          'document.querySelector("[data-logout]")?.textContent?.trim() === "Se déconnecter"',
          20_000,
        );
        expect(await view.evaluate<string>("document.documentElement.lang")).toBe("fr");
      });
    } finally {
      await setDefaultLocale("en");
    }
  }, 180_000);
});
