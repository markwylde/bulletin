import type { RouteBenchmark } from "./benchmark.ts";

/**
 * The registered latency benchmarks (ADR 0006, task 7.1). Every user-app route with its own
 * view-model contract adds an entry here when it lands, so CI keeps the cached guest, member
 * and cold p95 targets honest.
 */
export const BENCHMARK_ROUTES: readonly RouteBenchmark[] = [
  {
    name: "index",
    guestUrl: "/",
    memberUrl: "/",
    // `bench` is a cache-key-only input: every nonce is a fresh, cold render.
    coldUrl: (nonce) => `/?bench=${nonce}`,
  },
  {
    name: "demo",
    guestUrl: "/_demo/2",
    memberUrl: "/_demo/2",
    // `bench` is a cache-key-only input: every nonce is a fresh, cold render.
    coldUrl: (nonce) => `/_demo/2?bench=${nonce}`,
  },
];
