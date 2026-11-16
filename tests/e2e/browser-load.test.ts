import { describe, expect, test } from "bun:test";
import {
  clickSelector,
  waitForPageLoad,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";

const browserDescribe = Bun.env.BULLETIN_E2E === "1" ? describe : describe.skip;

browserDescribe("document load waits", () => {
  test("waits for reload assets and the background manifest before another navigation", async () => {
    let stylesheetLoaded = false;
    let manifestLoaded = false;
    const stylesheet = Promise.withResolvers<void>();
    const manifest = Promise.withResolvers<void>();
    const manifestRequested = Promise.withResolvers<void>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/slow.css") {
          await stylesheet.promise;
          stylesheetLoaded = true;
          return new Response("body { color: black; }", {
            headers: { "content-type": "text/css" },
          });
        }
        if (url.pathname === "/manifest.webmanifest") {
          manifestRequested.resolve();
          await manifest.promise;
          manifestLoaded = true;
          return Response.json({ name: "Load fixture", start_url: "/", display: "standalone" });
        }
        const next = url.searchParams.has("next");
        return new Response(
          `<html lang="${next ? "es" : "en"}"><head>${next ? '<link rel="stylesheet" href="/slow.css"><link rel="manifest" href="/manifest.webmanifest">' : ""}</head><body><a href="/?next" data-next>Next</a></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });

    try {
      await withPage({ url: server.url.toString(), viewport: "mobile360" }, async (view) => {
        await clickSelector(view, "[data-next]");
        await waitForSelector(view, 'html[lang="es"]');
        // The replacement document exists while its stylesheet still blocks load.
        expect(stylesheetLoaded).toBe(false);
        const loaded = waitForPageLoad(view);
        stylesheet.resolve();
        await manifestRequested.promise;
        expect(manifestLoaded).toBe(false);
        manifest.resolve();
        await loaded;
        expect(stylesheetLoaded).toBe(true);
        expect(manifestLoaded).toBe(true);
        await view.navigate(server.url.toString());
      });
    } finally {
      await server.stop(true);
    }
  }, 30_000);

  test("still fails on a malformed manifest", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/manifest.webmanifest") {
          return new Response("invalid manifest", {
            headers: { "content-type": "application/manifest+json" },
          });
        }
        return new Response(
          '<html><head><link rel="manifest" href="/manifest.webmanifest"></head></html>',
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    });

    try {
      await expect(
        withPage({ url: server.url.toString(), viewport: "mobile360" }, waitForPageLoad),
      ).rejects.toThrow("Manifest:");
    } finally {
      await server.stop(true);
    }
  }, 30_000);
});
