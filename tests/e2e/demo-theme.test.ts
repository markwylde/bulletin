import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  loginAs,
  VIEWPORTS,
  type ViewportName,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";

// Task 4.1/4.2: the default theme skeleton over the demo route, at every viewport. Runs
// against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const DEMO_URL = new URL("/_demo", userBaseUrl()).toString();
const USER_URL = userBaseUrl();

const viewportNames = Object.keys(VIEWPORTS) as ViewportName[];

integrationDescribe("demo theme", () => {
  for (const viewportName of viewportNames) {
    const viewport = VIEWPORTS[viewportName];

    test(`renders the theme skeleton at ${viewportName} (${viewport.width}px)`, async () => {
      await withPage({ url: `${DEMO_URL}/1`, viewport: viewportName }, async (view) => {
        await waitForSelector(view, "[data-theme-header]");
        await waitForSelector(view, "[data-breadcrumbs]");
        await waitForSelector(view, "[data-demo-children]");
        await waitForSelector(view, "[data-language-switcher]");
        await waitForSelector(view, "[data-theme-footer]");

        expect(await view.evaluate<boolean>("document.documentElement.clientWidth")).toBe(
          viewport.width,
        );
        expect(
          await view.evaluate<boolean>(
            "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
          ),
        ).toBe(true);
        expect(await view.evaluate<string>("document.documentElement.lang")).toBe("en");
      });
    });
  }

  test("shows the empty state for a forum without topics", async () => {
    await withPage({ url: `${DEMO_URL}/4`, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-theme-empty]");
      expect(await view.evaluate<string>("document.body.innerText")).not.toContain("Demo topic 1");
    });
  });

  test("returns the themed 404 for unknown demo ids and paths", async () => {
    for (const path of ["/_demo/99", "/_demo/abc", "/no-such-page"]) {
      const response = await fetch(`${userBaseUrl()}${path}`);

      expect(response.status).toBe(404);
      expect(await response.text()).toContain("data-theme-error");
    }
  });

  test("renders topics, the island, the hook fragment and the overlay placeholder", async () => {
    await withPage({ url: `${DEMO_URL}/2`, viewport: "mobile360" }, async (view) => {
      await waitForSelector(view, "[data-demo-topics]");
      await waitForSelector(view, "[data-demo-hook]");
      await waitForSelector(view, "[data-overlay-unread]");
      await waitForSelector(view, 'bl-island[data-name="SpikeCounter"]');

      const html = await view.evaluate<string>("document.body.innerHTML");
      expect(html).toContain("Demo topic 1");
      // Shared HTML carries a placeholder, never personal data (ADR 0006 task 6.3 fills it).
      expect(html).toContain('data-overlay-context="topic:201"');
    });
  });

  test("unlocks a password forum with its password", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.navigate(`${DEMO_URL}/3`);
      await waitForSelector(view, "[data-demo-locked]");

      await view.evaluate(`(() => {
        const input = document.querySelector("#demo-password");
        if (!(input instanceof HTMLInputElement)) return false;
        input.value = "demo-password";
        return true;
      })()`);
      await clickSelector(view, "[data-demo-unlock-submit]");

      await waitForSelector(view, "[data-demo-topics]", 20_000);
      expect(
        await view.evaluate<boolean>("document.querySelector('[data-demo-locked]') === null"),
      ).toBe(true);
    });
  }, 120_000);

  test("shows the moderator tools only to moderators", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-1");
      await view.navigate(`${DEMO_URL}/2`);
      await waitForSelector(view, "[data-demo-topics]");
      expect(
        await view.evaluate<boolean>("document.querySelector('[data-demo-mod-tools]') === null"),
      ).toBe(true);
    });

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "super-mod");
      await view.navigate(`${DEMO_URL}/2`);
      await waitForSelector(view, "[data-demo-mod-tools]");

      await clickSelector(view, "[data-demo-mod-tools]");
      await waitForSelector(view, "[data-demo-deleted]");
    });
  }, 120_000);
});
