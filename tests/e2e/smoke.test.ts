import { describe, expect, test } from "bun:test";
import { VIEWPORTS, type ViewportName, waitForSelector, withPage } from "@bulletin/test-utils/e2e";

// Run against the full stack:
//   docker compose up -d
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const APPS = [
  {
    name: "user-app",
    url: Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080",
  },
  {
    name: "staff-app",
    url: Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080",
  },
] as const;

const VIEWPORT_NAMES = Object.keys(VIEWPORTS) as ViewportName[];

for (const app of APPS) {
  integrationDescribe(`${app.name} smoke`, () => {
    for (const viewportName of VIEWPORT_NAMES) {
      const viewport = VIEWPORTS[viewportName];

      test(`opens at ${viewportName} (${viewport.width}x${viewport.height})`, async () => {
        await withPage({ url: app.url, viewport: viewportName }, async (view) => {
          await waitForSelector(view, "body");

          expect(await view.evaluate<string>("document.readyState")).toBe("complete");
          expect(await view.evaluate<number>("document.documentElement.clientWidth")).toBe(
            viewport.width,
          );
          expect(new URL(view.url).origin).toBe(new URL(app.url).origin);
        });
      }, 90_000);
    }
  });
}
