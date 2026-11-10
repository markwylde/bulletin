import { describe, expect, test } from "bun:test";
import {
  type BenchmarkFetch,
  formatBenchmarkResults,
  type RouteBenchmark,
  runBenchmarks,
} from "./benchmark.ts";

const route: RouteBenchmark = {
  name: "demo",
  guestUrl: "/_demo/2",
  memberUrl: "/_demo/2",
  coldUrl: (nonce) => `/_demo/2?bench=${nonce}`,
};

interface FakeOptions {
  readonly guestCache?: string;
  readonly memberCache?: string;
  readonly coldCache?: string;
  readonly memberBody?: string;
  readonly guestBody?: string;
  readonly delayMs?: number;
}

function fakeFetch(options: FakeOptions = {}): BenchmarkFetch {
  return async (input, init) => {
    if (options.delayMs !== undefined) {
      await Bun.sleep(options.delayMs);
    }

    const url = String(input);
    const isCold = url.includes("bench=");
    const isMember = !isCold && new Headers(init?.headers).has("cookie");
    const body = isCold
      ? '<html data-visitor="guest">'
      : isMember
        ? (options.memberBody ?? '<html data-visitor="member">')
        : (options.guestBody ?? '<html data-visitor="guest">');
    const cache = isCold
      ? (options.coldCache ?? "MISS")
      : isMember
        ? (options.memberCache ?? "HIT")
        : (options.guestCache ?? "HIT");

    return new Response(body, { status: 200, headers: { "x-cache": cache } });
  };
}

const options = {
  baseUrl: "http://stack.test",
  memberCookie: "bl_session=benchmark",
  samples: 5,
  warmup: 1,
};

describe("latency benchmark harness", () => {
  test("passes when guest and member samples are cached and cold samples miss", async () => {
    const [result] = await runBenchmarks([route], { ...options, fetchImpl: fakeFetch() });

    expect(result?.passed).toBe(true);
    expect(result?.failures).toEqual([]);
    expect(result?.guest.samples).toBe(5);
    expect(result?.guest.p95).toBeGreaterThanOrEqual(result?.guest.p50 ?? 0);
  });

  test("fails when the guest page is not served from the cache", async () => {
    const [result] = await runBenchmarks([route], {
      ...options,
      fetchImpl: fakeFetch({ guestCache: "MISS" }),
    });

    expect(result?.passed).toBe(false);
    expect(result?.failures.join("\n")).toContain("guest sample reported X-Cache MISS");
  });

  test("fails when the member session cookie is rejected", async () => {
    const [result] = await runBenchmarks([route], {
      ...options,
      fetchImpl: fakeFetch({ memberBody: '<html data-visitor="guest">' }),
    });

    expect(result?.failures.join("\n")).toContain("member samples did not render the member page");
  });

  test("fails when a cold sample hits the cache", async () => {
    const [result] = await runBenchmarks([route], {
      ...options,
      fetchImpl: fakeFetch({ coldCache: "HIT" }),
    });

    expect(result?.failures.join("\n")).toContain("cold sample reported X-Cache HIT");
  });

  test("fails when a p95 threshold is exceeded", async () => {
    const slow: RouteBenchmark = {
      ...route,
      thresholds: { guestP95Ms: -1 },
    };
    const [result] = await runBenchmarks([slow], { ...options, fetchImpl: fakeFetch() });

    expect(result?.passed).toBe(false);
    expect(result?.failures.join("\n")).toContain("guest p95");
  });

  test("formats a table with the result and each failure", async () => {
    const [result] = await runBenchmarks([route], {
      ...options,
      fetchImpl: fakeFetch({ guestCache: "MISS" }),
    });
    const text = formatBenchmarkResults(result === undefined ? [] : [result]);

    expect(text).toContain("route");
    expect(text).toContain("demo");
    expect(text).toContain("FAIL");
    expect(text).toContain("guest sample reported X-Cache MISS");
  });
});
