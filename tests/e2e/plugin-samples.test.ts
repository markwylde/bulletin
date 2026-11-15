import { describe, expect, test } from "bun:test";
import { clickSelector, loginAs, waitForSelector, withPage } from "@bulletin/test-utils/e2e";
import { stackOrigin, staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";

// The three seeded sample plugins work after `docker compose up --watch` (task 6.2).

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();
const PLUGIN_ORIGIN = stackOrigin("plugins");

integrationDescribe("sample plugins", () => {
  test("seeds hide-post-count disabled and the other samples active", async () => {
    await withPage({ url: `${STAFF_URL}/plugins`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-plugin-card="hide-post-count"]', 20_000);

      const states = await view.evaluate<Record<string, string>>(`Object.fromEntries(
        [...document.querySelectorAll("[data-plugin-card]")].map((card) => [
          card.getAttribute("data-plugin-card"),
          card.querySelector("[data-plugin-state]")?.getAttribute("data-plugin-state") ?? "",
        ])
      )`);
      expect(states["hide-post-count"]).toBe("disabled");
      expect(states["welcome-bot"]).toBe("active");
      expect(states["tip-jar"]).toBe("active");
      expect(
        await view.evaluate<boolean>(
          'Boolean(document.querySelector("[data-plugin-grant-warning]"))',
        ),
      ).toBe(false);
    });
  }, 120_000);

  test("a plugin-declared table page renders in the manager", async () => {
    await withPage({ url: `${STAFF_URL}/plugins`, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-plugin-configure="tip-jar"]:not([disabled])', 20_000);
      await clickSelector(view, '[data-plugin-configure="tip-jar"]');
      await waitForSelector(view, '[data-plugin-tab="page:recent-tips"]', 10_000);
      await clickSelector(view, '[data-plugin-tab="page:recent-tips"]');
      await waitForSelector(view, '[data-plugin-declared-page="recent-tips"]', 10_000);
      expect(
        await view.evaluate<string>(
          "document.querySelector('[data-plugin-declared-page=\"recent-tips\"]').innerText",
        ),
      ).toContain("5.00");
    });
  }, 120_000);

  test("tip-jar renders its sandboxed client app from the plugin origin", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await view.navigate(new URL("/forum/5-off-topic", USER_URL).toString());
      await waitForSelector(view, "[data-topic-list]", 20_000);
      const href = await view.evaluate<string | null>(
        'document.querySelector("[data-topic-list] [data-topic-link]")?.getAttribute("href") ?? null',
      );

      if (href === null) {
        throw new Error("Missing topic link");
      }

      await view.navigate(new URL(href, USER_URL).toString());
      await waitForSelector(view, 'iframe[data-plugin-frame="tip-jar"]', 20_000);
      expect(
        await view.evaluate<string>(
          'document.querySelector(\'iframe[data-plugin-frame="tip-jar"]\').getAttribute("src")',
        ),
      ).toStartWith(`${PLUGIN_ORIGIN}/apps/tip-jar/1/client/index.html`);
      expect(
        await view.evaluate<string>(
          'document.querySelector(\'iframe[data-plugin-frame="tip-jar"]\').getAttribute("sandbox")',
        ),
      ).toBe("allow-scripts allow-forms");
    });
  }, 120_000);
});
