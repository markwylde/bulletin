import { describe, expect, test } from "bun:test";
import {
  loginAs,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";
import { setFlagRules } from "./support/flags.ts";

// Run against the full stack:
//   docker compose up -d --build --wait
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const FORUM_URL = new URL("/forum/5-off-topic", USER_URL).toString();

const OFFLINE_ERRORS = [
  /ERR_INTERNET_DISCONNECTED/,
  /Failed to fetch/,
  /Failed to load resource/,
  /net::ERR/,
];

interface Manifest {
  readonly name: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: string;
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly {
    readonly src: string;
    readonly sizes: string;
    readonly type: string;
    readonly purpose: string;
  }[];
}

async function fetchManifest(view: Bun.WebView, query = ""): Promise<Manifest> {
  return view.evaluate<Manifest>(
    `fetch(${JSON.stringify(`/manifest.webmanifest${query}`)}, { credentials: "include" })
      .then((response) => response.json())`,
  );
}

async function serviceWorkerReady(view: Bun.WebView): Promise<void> {
  await waitForExpression(
    view,
    `"serviceWorker" in navigator && navigator.serviceWorker.getRegistrations().then((items) => items.length > 0)`,
    30_000,
  );
  await view.evaluate(
    "navigator.serviceWorker.ready.then((registration) => registration.active !== null)",
  );
}

interface AttachedTarget {
  readonly sessionId?: string;
  readonly targetInfo?: { readonly type?: string; readonly url?: string };
}

/**
 * Chrome's page-target network emulation does not cover the service worker's own fetches, so
 * the test also attaches to the worker target and takes it offline. This is what makes the
 * offline-navigation scenario exercise the real worker instead of the live server.
 */
async function offlineController(view: Bun.WebView): Promise<(offline: boolean) => Promise<void>> {
  const sessions = new Set<string>();

  view.addEventListener<AttachedTarget>("Target.attachedToTarget", (event) => {
    const info = event.data.targetInfo;

    if (
      event.data.sessionId !== undefined &&
      info?.type === "service_worker" &&
      (info.url ?? "").includes("bulletin.localhost")
    ) {
      sessions.add(event.data.sessionId);
    }
  });
  await view.cdp("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  await Bun.sleep(250);
  await view.cdp("Network.enable");

  return async (offline: boolean): Promise<void> => {
    const conditions = {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    };

    await view.cdp("Network.setCacheDisabled", { cacheDisabled: true });
    await view.cdp("Network.emulateNetworkConditions", conditions);

    for (const sessionId of sessions) {
      // `Target.sendMessageToTarget` still returns a promise from Bun.WebView's cdp wrapper.
      await view.cdp("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: 1, method: "Network.enable", params: {} }),
      });
      await view.cdp("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 2,
          method: "Network.emulateNetworkConditions",
          params: conditions,
        }),
      });
    }
  };
}

async function cachePaths(view: Bun.WebView): Promise<string[]> {
  return view.evaluate<string[]>(`(async () => {
    const paths = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        paths.push(new URL(request.url).pathname);
      }
    }
    return paths;
  })()`);
}

integrationDescribe("PWA", () => {
  test("offers an installable manifest with the active theme's colours", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      const manifest = await fetchManifest(view);

      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.start_url).toBe("/");
      expect(manifest.scope).toBe("/");
      expect(manifest.display).toBe("standalone");
      expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
        expect.arrayContaining(["192x192", "512x512"]),
      );

      const icon = await view.evaluate<{ status: number; type: string; bytes: number }>(
        `fetch(${JSON.stringify(manifest.icons[0]?.src ?? "")}).then(async (response) => ({
          status: response.status,
          type: response.headers.get("content-type") ?? "",
          bytes: (await response.arrayBuffer()).byteLength,
        }))`,
      );
      expect(icon.status).toBe(200);
      expect(icon.type).toBe("image/png");
      expect(icon.bytes).toBeGreaterThan(100);

      // A different theme must produce a different manifest, not a cached default one.
      const sunset = await view.evaluate<{ id: string; name: string } | null>(
        `fetch("/api/theme-options", { headers: { accept: "application/json" } })
          .then((response) => response.json())
          .then((body) => body.themes.find((theme) => theme.name === "sunset") ?? null)`,
      );

      if (sunset === null) {
        throw new Error("The seeded sunset theme is missing");
      }

      const themed = await fetchManifest(view, `?theme=${sunset.id}@1`);
      expect(themed.theme_color).toBe("#5b3fa8");
      expect(themed.theme_color).not.toBe(manifest.theme_color);
    });
  }, 120_000);

  test("the browser's manifest request carries the member's cookie", async () => {
    // The pwa flag is off for guests only; a credentialed manifest request succeeds for the
    // signed-in member, while a cookie-less one is a 404.
    const guestOff = [{ type: "group", groups: ["guests"], value: false }];

    try {
      await setFlagRules("pwa", guestOff);

      await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
        await loginAs(view, "member-1");
        await view.cdp("Network.enable");
        await view.cdp("Network.setCacheDisabled", { cacheDisabled: true });

        let status = 0;
        view.addEventListener<{
          readonly response?: { readonly url?: string; readonly status?: number };
        }>("Network.responseReceived", (event) => {
          if ((event.data.response?.url ?? "").includes("/manifest.webmanifest")) {
            status = event.data.response?.status ?? 0;
          }
        });

        await view.navigate(USER_URL);
        for (let attempt = 0; attempt < 100 && status === 0; attempt += 1) {
          await Bun.sleep(100);
        }

        expect(status).toBe(200);
      });
    } finally {
      await setFlagRules("pwa", []);
    }
  }, 180_000);

  test("caches only the shell and serves the offline page without forum content", async () => {
    await withPage(
      { url: USER_URL, viewport: "mobile360", allowConsoleErrors: OFFLINE_ERRORS },
      async (view) => {
        await loginAs(view, "member-1");
        await serviceWorkerReady(view);
        const setOffline = await offlineController(view);

        await view.navigate(FORUM_URL);
        await waitForSelector(view, "[data-topic-list] [data-topic-link]");
        const topic = await view.evaluate<{ href: string; title: string } | null>(`(() => {
          const link = document.querySelector("[data-topic-list] [data-topic-link]");
          if (!(link instanceof HTMLAnchorElement)) return null;
          return { href: link.getAttribute("href") ?? "", title: link.textContent ?? "" };
        })()`);

        if (topic === null) {
          throw new Error("The seeded forum has no topic");
        }

        await view.navigate(new URL(topic.href, USER_URL).toString());
        await waitForSelector(view, "[data-post-list]");
        await view.navigate(new URL("/members", USER_URL).toString());
        await waitForSelector(view, "main#main");

        const cached = await cachePaths(view);
        expect(cached).toContain("/offline");
        expect(cached).toContain("/theme-css");
        expect(
          cached.filter(
            (path) =>
              path.startsWith("/topic/") ||
              path.startsWith("/forum/") ||
              path.startsWith("/profile/") ||
              path.startsWith("/conversations"),
          ),
        ).toEqual([]);
        expect(cached.filter((path) => path.startsWith("/api/"))).toEqual([]);

        await setOffline(true);
        const offlineUrl = new URL(topic.href, USER_URL);
        offlineUrl.searchParams.set("pwa-offline", String(Date.now()));
        await view.navigate(offlineUrl.toString());
        await waitForSelector(view, "[data-offline-page]", 20_000);
        await waitForText(view, "You're offline", 20_000);

        const text = await view.evaluate<string>("document.body.innerText");
        expect(text).not.toContain(topic.title.trim());
        expect(text).toContain("Forum content is never stored on this device");
        // The theme stylesheet is precached and must still resolve without the network.
        const themeCss = await view.evaluate<string>(
          "fetch('/theme-css').then((response) => response.text())",
        );
        expect(themeCss).toContain("--bl-");

        await setOffline(false);
      },
    );
  }, 180_000);

  test("activates a new worker version and drops the previous shell cache", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await view.cdp("Network.enable");
      await view.cdp("Network.setCacheDisabled", { cacheDisabled: true });
      await serviceWorkerReady(view);
      const before = await view.evaluate<string[]>("caches.keys()");
      expect(before.length).toBeGreaterThan(0);

      const version = `e2e-${Date.now()}`;
      const active = await view.evaluate<string | null>(`(async () => {
        const registration = await navigator.serviceWorker.register(
          ${JSON.stringify(`/sw.js?v=${version}`)},
          { scope: "/", updateViaCache: "none" },
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (registration.active?.scriptURL.includes(${JSON.stringify(version)})) {
            return registration.active.scriptURL;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      })()`);

      expect(active).toContain(version);
      await waitForExpression(
        view,
        `caches.keys().then((names) => names.every((name) => name === "bulletin-shell-${version}"))`,
        20_000,
      );

      // A navigation still goes to the network; the offline page is only a fallback.
      await view.navigate(FORUM_URL);
      await waitForSelector(view, "[data-topic-list]", 20_000);
      expect(await view.evaluate<string>("document.body.innerText")).toContain("Off Topic");
    });
  }, 120_000);
});
