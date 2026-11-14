import { describe, expect, test } from "bun:test";
import { serviceWorkerSource } from "./service-worker.ts";

describe("service worker source", () => {
  const source = serviceWorkerSource({
    version: "abc123",
    assets: ["/_astro/app-1.js", "/_astro/app-2.css", "/not-an-asset.json"],
    titles: {
      en: { "push.title.generic": "Bulletin notification", "push.title.topicReply": "New reply" },
      es: { "push.title.generic": "Notificación de Bulletin" },
    },
  });

  test("is versioned by the registration URL and drops old shell caches", () => {
    expect(source).toContain('const BUILD_VERSION = "abc123";');
    expect(source).toContain('new URL(self.location.href).searchParams.get("v")');
    expect(source).toContain('"bulletin-shell-" + VERSION');
    expect(source).toContain('key.startsWith("bulletin-shell-") && key !== CACHE_NAME');
    expect(source).toContain("self.skipWaiting()");
    expect(source).toContain("self.clients.claim()");
  });

  test("precaches only the shell, offline page and hashed client assets", () => {
    expect(source).toContain('"/offline"');
    expect(source).toContain('"/theme-css"');
    expect(source).toContain('"/_astro/app-1.js"');
    expect(source).toContain('"/_astro/app-2.css"');
    expect(source).not.toContain("/not-an-asset.json");
  });

  test("navigations are network-only with the offline page as the fallback", () => {
    expect(source).toContain('request.mode === "navigate"');
    expect(source).toContain("networkWithOfflineFallback(request)");
    expect(source).toContain("caches.match(OFFLINE_URL)");
    // No content cache path: only the asset prefix is cache-first.
    expect(source).toContain("url.pathname.startsWith(ASSET_PREFIX)");
  });

  test("shows a content-free push after fetching an authenticated preview", () => {
    expect(source).toContain('self.addEventListener("push"');
    expect(source).toContain("/api/notifications/");
    expect(source).toContain('credentials: "include"');
    expect(source).toContain("self.registration.showNotification");
    expect(source).toContain("const TITLES =");
    expect(source).toContain('"push.title.topicReply":"New reply"');
    expect(source).toContain("data: { url, notificationId, loginRequired }");
  });

  test("opens the content or the login page when a notification is clicked", () => {
    expect(source).toContain('self.addEventListener("notificationclick"');
    expect(source).toContain('"/auth/login?return_to="');
    expect(source).toContain("self.clients.openWindow");
  });

  test("keeps the destination after login and rechecks authentication on click", () => {
    expect(source).toContain('new URL(self.location.href).searchParams.get("l")');
    expect(source).toContain("const LOCALE =");
    expect(source).toContain("function openUrl(notificationId)");
    expect(source).toContain('"/account/notifications?open="');
    expect(source).toContain("async function clickTarget(data)");
    expect(source).toContain('credentials: "include"');
    expect(source).toContain("loginUrl(openUrl(notificationId))");
  });

  test("handles a clear message without deleting the shell cache", () => {
    expect(source).toContain('event.data === "clear"');
    expect(source).toContain('key.startsWith("bulletin-") && key !== CACHE_NAME');
  });
});
