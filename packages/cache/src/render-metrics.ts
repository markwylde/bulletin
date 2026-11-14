import { standardMetrics } from "@bulletin/config/metrics";
import type { RenderStatus } from "./render-cache.ts";

/** Distinct variants remembered per route before the count stops growing (memory bound). */
const MAX_TRACKED_VARIANTS = 10_000;

/** Default per-route variant budget (ADR 0006, 0020); routes above it are flagged. */
export const DEFAULT_VARIANT_BUDGET = 64;

const variants = new Map<string, Set<string>>();

function decodePart(key: string, name: string): string | null {
  for (const part of key.split("&")) {
    const separator = part.indexOf("=");

    if (separator !== -1 && decodeURIComponent(part.slice(0, separator)) === name) {
      return decodeURIComponent(part.slice(separator + 1));
    }
  }

  return null;
}

/**
 * The route and the variant signature of a cache key. Page keys come from `variantKey`
 * (`route=…&params=…&…`); the signature drops `params`, so one route's variant count measures
 * how many viewer variants exist, not how many resources were rendered.
 */
export function describeCacheKey(key: string): { route: string; signature: string } {
  const route = decodePart(key, "route");

  if (route === null) {
    return { route: "fragment", signature: "fragment" };
  }

  const signature = key
    .split("&")
    .filter((part) => !part.startsWith("params="))
    .join("&");

  return { route, signature };
}

/** Records one render-cache lookup into the process metrics (ADR 0020). */
export function recordCacheRender(key: string, status: RenderStatus, seconds: number): void {
  const { route, signature } = describeCacheKey(key);
  standardMetrics.cacheRequests.inc({ route, result: status });

  if (status === "bypass") {
    standardMetrics.cacheBypassSeconds.inc({ route }, Math.max(0, seconds));
    return;
  }

  let seen = variants.get(route);

  if (seen === undefined) {
    seen = new Set();
    variants.set(route, seen);
  }

  if (seen.size < MAX_TRACKED_VARIANTS && !seen.has(signature)) {
    seen.add(signature);
    standardMetrics.cacheVariants.set({ route }, seen.size);
  }
}

/** Adds time the invalidation listener spent untrusted (fail-closed bypass). */
export function recordCacheUntrusted(seconds: number): void {
  if (seconds > 0) {
    standardMetrics.cacheUntrustedSeconds.inc({}, seconds);
  }
}

/** Test seam: forget the remembered variants. */
export function resetCacheVariantTracking(): void {
  variants.clear();
  standardMetrics.cacheVariants.reset();
}
