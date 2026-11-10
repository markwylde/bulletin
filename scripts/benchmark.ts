/**
 * The latency benchmark against the seeded stack (ADR 0006, task 7.1).
 *
 *   docker compose up -d --wait
 *   bun run benchmark
 *
 * It measures cached guest, member and cold p95 TTFB for every route registered in
 * `@bulletin/test-utils/benchmark-routes` and exits non-zero when an ADR 0006 threshold is
 * exceeded. The member session comes from the dev-only `/api/test/session` endpoint, so no
 * browser is needed; the script refuses to guess and fails clearly outside development.
 */

import {
  formatBenchmarkResults,
  type RouteBenchmark,
  runBenchmarks,
} from "@bulletin/test-utils/benchmark";
import { BENCHMARK_ROUTES } from "@bulletin/test-utils/benchmark-routes";
import { userOrigin } from "@bulletin/test-utils/urls";

const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [name = "", value] = argument.slice(2).split("=");
      return [name, value ?? "true"] as const;
    }),
);

function positiveInteger(name: string, fallback: number): number {
  const raw = args.get(name);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }

  return value;
}

async function benchmarkSessionCookie(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/test/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ sub: "member-1" }),
  });

  if (!response.ok) {
    throw new Error(
      `Could not create a benchmark session (HTTP ${response.status}). ` +
        "Run against a non-production stack with the seeded member-1 profile.",
    );
  }

  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  if (!/^(?:__Host-)?bl_session=/.test(cookie)) {
    throw new Error("The benchmark session response did not set a session cookie");
  }

  return cookie;
}

const baseUrl = (args.get("base") ?? userOrigin()).replace(/\/$/, "");
const samples = positiveInteger("samples", 30);
const warmup = positiveInteger("warmup", 5);
const only = args.get("route");
const routes: readonly RouteBenchmark[] =
  only === undefined ? BENCHMARK_ROUTES : BENCHMARK_ROUTES.filter((route) => route.name === only);

if (routes.length === 0) {
  console.error(`No benchmark route matches "${only ?? ""}"`);
  process.exit(2);
}

const memberCookie = await benchmarkSessionCookie(baseUrl);
const results = await runBenchmarks(routes, {
  baseUrl,
  memberCookie,
  samples,
  warmup,
});

console.log(`bulletin latency benchmark — ${baseUrl} (${samples} samples, ${warmup} warmup)`);
console.log(formatBenchmarkResults(results));

process.exit(results.every((result) => result.passed) ? 0 : 1);
