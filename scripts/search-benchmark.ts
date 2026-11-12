/**
 * Search latency benchmark (ADR 0017, ADR 0020, search task 4.1).
 *
 *   SEED_SIZE=large docker compose up -d --wait
 *   bun run search:benchmark
 *
 * It measures the full server-rendered search page for common queries and exits non-zero when
 * the p95 exceeds 300 ms. The stack must be seeded with the large dataset.
 */

import { userOrigin } from "@bulletin/test-utils/urls";

const TARGET_P95_MS = 300;
const DEFAULT_QUERIES = ["favourite", "reading", "editor", "weekend", "question"];

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

interface Sample {
  readonly ms: number;
  readonly status: number;
  readonly rendered: boolean;
}

function percentile(sorted: readonly number[], value: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((value / 100) * sorted.length))] ?? 0;
}

async function measure(baseUrl: string, path: string): Promise<Sample> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    // A fresh guest identity keeps the flood bucket out of the latency measurement.
    headers: { accept: "text/html", cookie: `bl_guest=${crypto.randomUUID()}` },
    redirect: "manual",
  });
  // TTFB, as in the route benchmark: the body is drained after the headers arrive.
  const ms = performance.now() - started;
  const body = await response.text();

  return { ms, status: response.status, rendered: body.includes("data-search-page") };
}

const baseUrl = (args.get("base") ?? userOrigin()).replace(/\/$/, "");
const samples = positiveInteger("samples", 30);
const warmup = positiveInteger("warmup", 5);
const queries = (args.get("queries") ?? DEFAULT_QUERIES.join(","))
  .split(",")
  .map((query) => query.trim())
  .filter((query) => query !== "");

if (queries.length === 0) {
  console.error("No search queries to benchmark");
  process.exit(2);
}

const results: Array<{ query: string; p50: number; p95: number; p99: number; ms: number[] }> = [];
let failed = false;

for (const query of queries) {
  const path = `/search?q=${encodeURIComponent(query)}&kind=posts`;

  for (let index = 0; index < warmup; index += 1) {
    await measure(baseUrl, path);
  }

  const timings: number[] = [];

  for (let index = 0; index < samples; index += 1) {
    const sample = await measure(baseUrl, path);

    if (sample.status !== 200 || !sample.rendered) {
      console.error(`Query "${query}" returned HTTP ${sample.status} without the search page`);
      failed = true;
    }

    timings.push(sample.ms);
  }

  const sorted = [...timings].sort((left, right) => left - right);
  const p95 = Math.round(percentile(sorted, 95) * 100) / 100;

  if (p95 > TARGET_P95_MS) {
    failed = true;
  }

  results.push({
    query,
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p95,
    p99: Math.round(percentile(sorted, 99) * 100) / 100,
    ms: sorted,
  });
}

console.log(`bulletin search benchmark — ${baseUrl} (${samples} samples, ${warmup} warmup)`);
console.log(`target: p95 < ${TARGET_P95_MS} ms`);
console.log("query        p50 ms   p95 ms   p99 ms   result");

for (const result of results) {
  console.log(
    `${result.query.padEnd(12)} ${String(result.p50).padStart(7)}  ${String(result.p95).padStart(7)}  ` +
      `${String(result.p99).padStart(7)}   ${result.p95 < TARGET_P95_MS ? "PASS" : "FAIL"}`,
  );
}

process.exit(failed ? 1 : 0);
