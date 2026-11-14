import { describe, expect, test } from "bun:test";
import { waitForExpression, withPage } from "@bulletin/test-utils/e2e";
import { serviceWorkerSource } from "../../apps/user-app/src/pwa/service-worker.ts";

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const OFF_PAGE = "<!doctype html><html><body><main data-offline-page>Offline</main></body></html>";

/**
 * A real browser deployment simulation: the two worker versions are built from different
 * content-hashed asset names, exactly as an Astro build emits after a deploy. The second
 * activation must drop the first shell cache and leave only the new asset.
 */
integrationDescribe("PWA deployment", () => {
  test("activates a new build hash and removes the previous asset cache", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/sw.js") {
          const version = url.searchParams.get("v") === "2" ? "2" : "1";

          return new Response(
            serviceWorkerSource({
              version,
              assets: [version === "1" ? "/_astro/app-1.js" : "/_astro/app-2.js"],
              titles: {},
            }),
            { headers: { "content-type": "text/javascript; charset=utf-8" } },
          );
        }

        if (url.pathname === "/offline") {
          return new Response(OFF_PAGE, { headers: { "content-type": "text/html" } });
        }

        if (url.pathname === "/theme-css" || url.pathname.endsWith(".css")) {
          return new Response("body{}", { headers: { "content-type": "text/css" } });
        }

        if (url.pathname.startsWith("/_astro/")) {
          return new Response(`/* ${url.pathname} */`, {
            headers: { "content-type": "text/javascript" },
          });
        }

        return new Response(
          `<!doctype html><html><body><script>
            navigator.serviceWorker.register("/sw.js?v=1", { scope: "/" });
          </script></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });

    try {
      await withPage(
        { url: `http://127.0.0.1:${server.port}/`, viewport: "mobile360" },
        async (view) => {
          await waitForExpression(
            view,
            `navigator.serviceWorker.ready.then((registration) => registration.active?.scriptURL.includes("v=1") ?? false)`,
            30_000,
          );
          expect(await view.evaluate<string[]>("caches.keys()")).toEqual(["bulletin-shell-1"]);
          expect(
            await view.evaluate<boolean>(`caches.match("/_astro/app-1.js").then(Boolean)`),
          ).toBe(true);

          const active = await view.evaluate<string | null>(`(async () => {
          const registration = await navigator.serviceWorker.register("/sw.js?v=2", { scope: "/" });
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (registration.active?.scriptURL.includes("v=2")) {
              return registration.active.scriptURL;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return null;
        })()`);

          expect(active).toContain("v=2");
          await waitForExpression(
            view,
            `caches.keys().then((names) => names.length === 1 && names[0] === "bulletin-shell-2")`,
            20_000,
          );
          expect(
            await view.evaluate<boolean>(`caches.match("/_astro/app-1.js").then(Boolean)`),
          ).toBe(false);
          expect(
            await view.evaluate<boolean>(`caches.match("/_astro/app-2.js").then(Boolean)`),
          ).toBe(true);
        },
      );
    } finally {
      server.stop(true);
    }
  }, 120_000);
});
