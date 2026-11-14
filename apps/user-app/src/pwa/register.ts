/**
 * Registers the service worker (ADR 0014). The build version is part of the script URL, so a
 * deploy registers a different worker and its activate step drops the previous shell cache.
 * Browsers without support, or a failed registration, leave the app working online.
 */

const root = document.documentElement;
const version = root.dataset.pwaVersion ?? "";

if (version !== "" && "serviceWorker" in navigator) {
  void navigator.serviceWorker
    .register(`/sw.js?v=${encodeURIComponent(version)}`, {
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
