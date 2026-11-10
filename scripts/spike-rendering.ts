/**
 * Spike S1 measurement harness (ADR 0008, tasks 1.1 and 1.2).
 *
 * Measures the rendering stack twice:
 *   1. In-process: Liquid parse + render + island SSR, and a cached fragment lookup. No
 *      database and no HTTP, so the number is the render cost itself.
 *   2. Over HTTP against a running user-app: cold (every variant a miss) and warm (a hit per
 *      request), plus the correctness checks for the theme switch and plugin generation.
 *
 * Usage:
 *   bun scripts/spike-rendering.ts                        # uses BULLETIN_HTTP_PORT
 *   bun scripts/spike-rendering.ts --serve                # starts the built server first
 *   bun scripts/spike-rendering.ts --serve --port=4399    # after building with an adapter
 */

import { createFragmentCache } from "@bulletin/cache";
import { createServerT } from "@bulletin/i18n";
import {
  createTemplateEngine,
  loadSpikeFixtures,
  SPIKE_HOOK_NAME,
  type SpikeHookFixture,
} from "@bulletin/templates";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";

const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [name = "", value] = argument.slice(2).split("=");
      return [name, value ?? "true"] as const;
    }),
);

const SERVE = args.has("serve");
const PORT = Number(args.get("port") ?? "4399");
const COLD_SAMPLES = Number(args.get("cold") ?? "30");
const WARM_SAMPLES = Number(args.get("warm") ?? "200");
const RENDER_SAMPLES = Number(args.get("render") ?? "80");

const HTTP_PORT = Bun.env.BULLETIN_HTTP_PORT ?? "8080";
const BASE_URL = SERVE
  ? `http://127.0.0.1:${PORT}`
  : (args.get("base") ?? `http://bulletin.localhost:${HTTP_PORT}`);

interface Timing {
  readonly name: string;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

function summarise(name: string, durations: readonly number[]): Timing {
  if (durations.length === 0) {
    throw new Error(`No samples for ${name}`);
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const at = (percentile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length))] ?? 0;
  const round = (value: number): number => Math.round(value * 100) / 100;

  return {
    name,
    samples: sorted.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

function print(timing: Timing): void {
  console.log(
    `${timing.name.padEnd(34)} n=${String(timing.samples).padStart(4)}  ` +
      `p50=${String(timing.p50).padStart(6)}ms  p95=${String(timing.p95).padStart(6)}ms  ` +
      `p99=${String(timing.p99).padStart(6)}ms  min=${String(timing.min).padStart(6)}ms  ` +
      `max=${String(timing.max).padStart(6)}ms`,
  );
}

/** Liquid parse + render + island SSR, then a warm fragment-cache lookup. */
async function measureRenderCost(): Promise<readonly Timing[]> {
  const fixtures = await loadSpikeFixtures();
  const theme = fixtures.themes[0];
  const hook = fixtures.hooks.find((fixture: SpikeHookFixture) => fixture.generation === 1);

  if (theme === undefined || hook === undefined) {
    throw new Error("Spike fixtures are incomplete");
  }

  const viewModel = {
    theme: theme.theme,
    version: theme.version,
    generation: 1,
    escapedSample: '<script>alert("spike")</script>',
    island: { label: "Clicks", start: 0 },
  };
  const engine = createTemplateEngine({
    translate: createServerT("en"),
    islands: SERVER_ISLANDS,
    hooks: { [SPIKE_HOOK_NAME]: hook.body },
  });

  const renderDurations: number[] = [];

  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    await engine.render(theme.template, viewModel);
    renderDurations.push(performance.now() - started);
  }

  const cache = createFragmentCache();
  await cache.getOrRender("render-cost", () => engine.render(theme.template, viewModel));

  const cacheDurations: number[] = [];

  for (let index = 0; index < RENDER_SAMPLES; index += 1) {
    const started = performance.now();
    await cache.getOrRender("render-cost", () => {
      throw new Error("a warm fragment must never re-render");
    });
    cacheDurations.push(performance.now() - started);
  }

  return [
    summarise("render: parse+island SSR", renderDurations),
    summarise("render: cached fragment lookup", cacheDurations),
  ];
}

async function waitForServer(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health/live`);

      if (response.ok) {
        return;
      }
    } catch {
      // The server is still starting.
    }

    await Bun.sleep(100);
  }

  throw new Error(`The built server did not become healthy at ${baseUrl}`);
}

async function startBuiltServer(): Promise<{ readonly stop: () => void }> {
  const child = Bun.spawn(["bun", "apps/user-app/dist/server/entry.mjs"], {
    cwd: `${import.meta.dir}/..`,
    env: { ...Bun.env, HOST: "127.0.0.1", PORT: String(PORT) },
    stdout: "ignore",
    stderr: "inherit",
  });

  return {
    stop() {
      child.kill("SIGTERM");
    },
  };
}

function spikeUrl(baseUrl: string, params: Record<string, string | number>): string {
  const url = new URL("/spike/rendering", baseUrl);

  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }

  return url.toString();
}

interface SpikeResponse {
  readonly html: string;
  readonly cache: string | null;
  readonly variant: string | null;
  readonly elapsed: number;
}

async function requestSpike(
  params: Record<string, string | number>,
  expected: "HIT" | "MISS" | "any" = "any",
): Promise<SpikeResponse> {
  const started = performance.now();
  const response = await fetch(spikeUrl(BASE_URL, params));
  const html = await response.text();
  const elapsed = performance.now() - started;
  const cache = response.headers.get("x-spike-cache");
  const variant = response.headers.get("x-spike-variant");

  if (!response.ok) {
    throw new Error(`GET ${response.url} returned ${response.status}`);
  }

  if (expected !== "any" && cache !== expected) {
    throw new Error(`Expected X-Spike-Cache ${expected}, received ${cache ?? "(missing)"}`);
  }

  return { html, cache, variant, elapsed };
}

async function measureHttp(): Promise<readonly Timing[]> {
  const cold: number[] = [];

  for (let index = 0; index < COLD_SAMPLES; index += 1) {
    const result = await requestSpike({ bust: 100_000 + index }, "MISS");
    cold.push(result.elapsed);
  }

  const warmKey = 900_000 + Math.floor(Math.random() * 100_000);
  await requestSpike({ bust: warmKey }, "MISS");

  const warm: number[] = [];

  for (let index = 0; index < WARM_SAMPLES; index += 1) {
    const result = await requestSpike({ bust: warmKey }, "HIT");
    warm.push(result.elapsed);
  }

  return [
    summarise(`http: cold (miss, ${BASE_URL})`, cold),
    summarise(`http: warm (hit, ${BASE_URL})`, warm),
  ];
}

async function checkVariants(): Promise<void> {
  const run = 500_000 + Math.floor(Math.random() * 100_000);
  const base = await requestSpike({ theme: "default", plugins: 1, bust: run }, "MISS");
  const altTheme = await requestSpike({ theme: "alt", plugins: 1, bust: run }, "MISS");
  const plugin = await requestSpike({ theme: "default", plugins: 2, bust: run }, "MISS");
  const baseAgain = await requestSpike({ theme: "default", plugins: 1, bust: run }, "HIT");

  const failures: string[] = [];

  if (!base.html.includes("<bl-island") || !base.html.includes("<button")) {
    failures.push("the default variant has no server-rendered island");
  }

  if (!base.html.includes('data-spike-hook="1"')) {
    failures.push("the default variant has no generation-1 hook fragment");
  }

  if (altTheme.html.includes('data-spike-layout="default"') || !altTheme.html.includes("alt")) {
    failures.push("the alternate theme did not replace the default layout");
  }

  if (!plugin.html.includes('data-spike-hook="2"')) {
    failures.push("the plugin generation did not change the hook fragment");
  }

  if (baseAgain.html !== base.html || baseAgain.variant !== base.variant) {
    failures.push("the cached default variant changed after other variants were rendered");
  }

  if (new Set([base.variant, altTheme.variant, plugin.variant]).size !== 3) {
    failures.push("the theme switch and plugin generation did not produce distinct variants");
  }

  if (failures.length > 0) {
    throw new Error(`Variant checks failed:\n- ${failures.join("\n- ")}`);
  }

  console.log(`variants: ${base.variant}`);
  console.log(`variants: ${altTheme.variant}`);
  console.log(`variants: ${plugin.variant}`);
}

const renderTimings = await measureRenderCost();

for (const timing of renderTimings) {
  print(timing);
}

let server: { readonly stop: () => void } | null = null;

try {
  if (SERVE) {
    server = await startBuiltServer();
    await waitForServer(BASE_URL);
  }

  await checkVariants();

  for (const timing of await measureHttp()) {
    print(timing);
  }
} finally {
  server?.stop();
}
