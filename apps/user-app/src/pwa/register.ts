/**
 * Registers the service worker (ADR 0014). The build version is part of the script URL, so a
 * deploy registers a different worker and its activate step drops the previous shell cache.
 * Browsers without support, or a failed registration, leave the app working online.
 */

const root = document.documentElement;
const version = root.dataset.pwaVersion ?? "";
// The worker picks the member's resolved locale from its registration URL (ADR 0013).
const locale = root.lang === "" ? "en" : root.lang;

if (version !== "" && "serviceWorker" in navigator) {
  void navigator.serviceWorker
    .register(`/sw.js?v=${encodeURIComponent(version)}&l=${encodeURIComponent(locale)}`, {
      scope: "/",
      updateViaCache: "none",
    })
    .then(async () => {
      await navigator.serviceWorker.ready;
      root.dataset.pwa = "ready";
    })
    .catch(() => {
      root.dataset.pwa = "unavailable";
    });
}
