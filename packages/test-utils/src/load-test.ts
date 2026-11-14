/**
 * The nightly capacity load test (ADR 0020). Virtual users run in worker threads:
 *
 * - guests read cached pages, either straight from the origin (CDN bypassed, to measure what
 *   user-app itself serves) or through the CDN (end to end),
 * - members load pages, call the private overlay and hold SSE streams,
 * - writers post replies at a fixed rate.
 *
 * Latencies are recorded in 0.1 ms buckets per route, merged across threads, and asserted
 * against the ADR 0006 page targets, the write rate, the error budget, queue lag (< 5 s) and
 * the per-route variant budget read from the services' internal `/metrics`.
 */

import { METRIC_FAMILIES, parsePrometheusText } from "@bulletin/config/metrics";

export type LoadRole = "guest" | "guest-cdn" | "member" | "writer" | "sse";

export interface LoadThresholds {
  /** Cached guest pages, origin and CDN (ADR 0006: 30 ms). */
  readonly guestP95Ms: number;
  /** Member pages and the overlay (ADR 0006: 80 ms). */
  readonly memberP95Ms: number;
  /** Replies (writes include the transaction and outbox insert). */
  readonly writeP95Ms: number;
  /** Sustained successful writes per second. */
  readonly writesPerSecond: number;
  /** Failed requests over all requests (throttled writes count as failures). */
  readonly maxErrorRate: number;
  readonly maxQueueLagSeconds: number;
  readonly variantBudget: number;
}

export const CAPACITY_THRESHOLDS: LoadThresholds = {
  guestP95Ms: 30,
  memberP95Ms: 80,
  writeP95Ms: 250,
  writesPerSecond: 50,
  maxErrorRate: 0.01,
  maxQueueLagSeconds: 5,
  variantBudget: 64,
};

export interface LoadUsers {
  /** Concurrent virtual users per role; each waits `thinkMs` between requests. */
  readonly guests: number;
  readonly cdnGuests: number;
  readonly members: number;
  readonly sseClients: number;
  /** Writers post at `writesPerSecond` in total, spread across threads. */
  readonly writesPerSecond: number;
}

/** ADR 0020 v1 targets: 2,000 members, 20,000 guests, 50 writes/s. */
export const CAPACITY_USERS: LoadUsers = {
  guests: 20_000,
  cdnGuests: 0,
  members: 2_000,
  sseClients: 2_000,
  writesPerSecond: 50,
};

export interface LoadSession {
  /** `name=value` session cookie. */
  readonly cookie: string;
}

export interface LoadConfig {
  /** The origin (user-app via the proxy, CDN bypassed). */
  readonly baseUrl: string;
  /** The CDN mock in front of user-app, for the end-to-end guest leg. */
  readonly cdnUrl?: string;
  readonly durationMs: number;
  /** Requests before `durationMs` starts counting (cache warm-up). */
  readonly warmupMs?: number;
  readonly thinkMs: number;
  readonly users: LoadUsers;
  readonly guestPaths: readonly string[];
  readonly memberPaths: readonly string[];
  /** Overlay contexts for members, e.g. `topic:345`. */
  readonly overlayContexts: readonly string[];
  readonly sessions: readonly LoadSession[];
  readonly writerSessions: readonly LoadSession[];
  readonly replyTopicIds: readonly string[];
  readonly threads: number;
  /** Internal `/metrics` URLs scraped during the run (queue lag, variants). */
  readonly metricsUrls: readonly string[];
}

/** Bucketed latencies: index = round(ms * 10), capped at 10 s. */
export const LATENCY_BUCKETS = 100_001;

export interface RouteSamples {
  readonly role: LoadRole;
  readonly route: string;
  count: number;
  errors: number;
  readonly buckets: Uint32Array;
}

export interface WorkerResult {
  readonly routes: ReadonlyArray<{
    readonly role: LoadRole;
    readonly route: string;
    readonly count: number;
    readonly errors: number;
    readonly buckets: Uint32Array;
  }>;
  readonly sseOpened: number;
  readonly sseFailed: number;
}

export interface RouteResult {
  readonly role: LoadRole;
  readonly route: string;
  readonly count: number;
  readonly errors: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly perSecond: number;
}

export interface MetricsScrape {
  readonly url: string;
  readonly ok: boolean;
  /** Why the scrape could not be used: unreachable, `HTTP <status>`, empty or malformed. */
  readonly reason?: string;
}

export interface MetricsObservation {
  readonly maxQueueLagSeconds: number;
  readonly laggingQueue: string | null;
  readonly variants: ReadonlyArray<{ readonly route: string; readonly variants: number }>;
  /** One entry per endpoint; merged observations keep an endpoint ok if any poll read it. */
  readonly scrapes: readonly MetricsScrape[];
  /** Metric families seen in usable scrapes. */
  readonly families: readonly string[];
}

/**
 * Families a capacity run cannot be judged without: zero lag or no variants must come from a
 * service that reported them, never from a scrape that failed.
 */
export const REQUIRED_METRIC_FAMILIES: readonly string[] = [
  METRIC_FAMILIES.queueLag,
  METRIC_FAMILIES.cacheVariants,
];

export interface LoadReport {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly routes: readonly RouteResult[];
  readonly sse: { readonly opened: number; readonly failed: number };
  readonly metrics: MetricsObservation;
  readonly failures: readonly string[];
  readonly passed: boolean;
}

export function newSamples(role: LoadRole, route: string): RouteSamples {
  return { role, route, count: 0, errors: 0, buckets: new Uint32Array(LATENCY_BUCKETS) };
}

export function recordSample(samples: RouteSamples, ms: number, ok: boolean): void {
  samples.count += 1;

  if (!ok) {
    samples.errors += 1;
    return;
  }

  const index = Math.min(LATENCY_BUCKETS - 1, Math.max(0, Math.round(ms * 10)));
  samples.buckets[index] = (samples.buckets[index] ?? 0) + 1;
}

export function percentile(buckets: Uint32Array, fraction: number): number {
  let total = 0;

  for (const value of buckets) {
    total += value;
  }

  if (total === 0) {
    return 0;
  }

  const target = Math.ceil(total * fraction);
  let seen = 0;

  for (let index = 0; index < buckets.length; index += 1) {
    seen += buckets[index] ?? 0;

    if (seen >= target) {
      return index / 10;
    }
  }

  return (buckets.length - 1) / 10;
}

export function mergeResults(
  results: readonly WorkerResult[],
  durationMs: number,
): {
  routes: RouteResult[];
  sse: { opened: number; failed: number };
} {
  const merged = new Map<string, RouteSamples>();
  let opened = 0;
  let failed = 0;

  for (const result of results) {
    opened += result.sseOpened;
    failed += result.sseFailed;

    for (const route of result.routes) {
      const key = `${route.role} ${route.route}`;
      let target = merged.get(key);

      if (target === undefined) {
        target = newSamples(route.role, route.route);
        merged.set(key, target);
      }

      target.count += route.count;
      target.errors += route.errors;

      for (let index = 0; index < route.buckets.length; index += 1) {
        const value = route.buckets[index] ?? 0;

        if (value > 0) {
          target.buckets[index] = (target.buckets[index] ?? 0) + value;
        }
      }
    }
  }

  const seconds = Math.max(durationMs / 1_000, 0.001);

  return {
    routes: [...merged.values()]
      .map((samples) => ({
        role: samples.role,
        route: samples.route,
        count: samples.count,
        errors: samples.errors,
        p50: percentile(samples.buckets, 0.5),
        p95: percentile(samples.buckets, 0.95),
        p99: percentile(samples.buckets, 0.99),
        perSecond: Math.round(((samples.count - samples.errors) / seconds) * 100) / 100,
      }))
      .sort((left, right) =>
        `${left.role} ${left.route}`.localeCompare(`${right.role} ${right.route}`),
      ),
    sse: { opened, failed },
  };
}

/** Reads queue lag and variant counts from the services' metrics. */
export async function observeMetrics(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<MetricsObservation> {
  let maxQueueLagSeconds = 0;
  let laggingQueue: string | null = null;
  const variants = new Map<string, number>();
  const scrapes: MetricsScrape[] = [];
  const families = new Set<string>();

  for (const url of urls) {
    let text: string;

    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });

      if (!response.ok) {
        scrapes.push({ url, ok: false, reason: `HTTP ${response.status}` });
        continue;
      }

      text = await response.text();
    } catch {
      scrapes.push({ url, ok: false, reason: "unreachable" });
      continue;
    }

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    const samples = parsePrometheusText(text);

    if (lines.length === 0) {
      scrapes.push({ url, ok: false, reason: "empty" });
      continue;
    }

    // Every sample line must parse; a partly garbled exposition is not trusted at all.
    if (samples.length !== lines.length) {
      scrapes.push({ url, ok: false, reason: "malformed" });
      continue;
    }

    scrapes.push({ url, ok: true });

    for (const sample of samples) {
      families.add(sample.name);

      if (sample.name === METRIC_FAMILIES.queueLag && sample.value > maxQueueLagSeconds) {
        maxQueueLagSeconds = sample.value;
        laggingQueue = sample.labels.queue ?? null;
      }

      if (sample.name === METRIC_FAMILIES.cacheVariants && sample.labels.route !== undefined) {
        variants.set(
          sample.labels.route,
          Math.max(variants.get(sample.labels.route) ?? 0, sample.value),
        );
      }
    }
  }

  return {
    maxQueueLagSeconds,
    laggingQueue,
    variants: [...variants].map(([route, count]) => ({ route, variants: count })),
    scrapes,
    families: [...families],
  };
}

export function mergeObservations(observations: readonly MetricsObservation[]): MetricsObservation {
  let maxQueueLagSeconds = 0;
  let laggingQueue: string | null = null;
  const variants = new Map<string, number>();
  const scrapes = new Map<string, MetricsScrape>();
  const families = new Set<string>();

  for (const observation of observations) {
    if (observation.maxQueueLagSeconds > maxQueueLagSeconds) {
      maxQueueLagSeconds = observation.maxQueueLagSeconds;
      laggingQueue = observation.laggingQueue;
    }

    for (const entry of observation.variants) {
      variants.set(entry.route, Math.max(variants.get(entry.route) ?? 0, entry.variants));
    }

    for (const scrape of observation.scrapes) {
      if (scrapes.get(scrape.url)?.ok !== true) {
        scrapes.set(scrape.url, scrape);
      }
    }

    for (const family of observation.families) {
      families.add(family);
    }
  }

  return {
    maxQueueLagSeconds,
    laggingQueue,
    variants: [...variants].map(([route, count]) => ({ route, variants: count })),
    scrapes: [...scrapes.values()],
    families: [...families],
  };
}

/** Every threshold breach, naming the route or queue responsible. */
export function evaluateLoad(
  routes: readonly RouteResult[],
  sse: { readonly opened: number; readonly failed: number },
  metrics: MetricsObservation,
  thresholds: LoadThresholds,
  expected: { readonly writesPerSecond: number; readonly sseClients: number },
): string[] {
  const failures: string[] = [];
  let requests = 0;
  let errors = 0;
  let writes = 0;

  for (const route of routes) {
    requests += route.count;
    errors += route.errors;

    const limit =
      route.role === "guest" || route.role === "guest-cdn"
        ? thresholds.guestP95Ms
        : route.role === "member"
          ? thresholds.memberP95Ms
          : route.role === "writer"
            ? thresholds.writeP95Ms
            : null;

    if (limit !== null && route.count - route.errors > 0 && route.p95 > limit) {
      failures.push(
        `${route.role} ${route.route}: p95 ${route.p95.toFixed(1)} ms exceeds ${limit} ms`,
      );
    }

    if (route.role === "writer") {
      writes += route.perSecond;
    }
  }

  if (requests > 0 && errors / requests > thresholds.maxErrorRate) {
    failures.push(
      `error rate ${((errors / requests) * 100).toFixed(2)}% exceeds ${(
        thresholds.maxErrorRate * 100
      ).toFixed(2)}%`,
    );
  }

  const writeTarget = Math.min(thresholds.writesPerSecond, expected.writesPerSecond);

  if (expected.writesPerSecond > 0 && writes < writeTarget * 0.95) {
    failures.push(`writes: ${writes.toFixed(1)}/s sustained, below ${writeTarget}/s`);
  }

  if (expected.sseClients > 0 && sse.opened < expected.sseClients) {
    failures.push(`sse: ${sse.opened} of ${expected.sseClients} streams opened`);
  }

  if (metrics.maxQueueLagSeconds > thresholds.maxQueueLagSeconds) {
    failures.push(
      `queue ${metrics.laggingQueue ?? "?"}: lag ${metrics.maxQueueLagSeconds.toFixed(1)} s exceeds ${
        thresholds.maxQueueLagSeconds
      } s`,
    );
  }

  if (metrics.scrapes.length === 0) {
    failures.push("metrics: no endpoints configured");
  } else {
    for (const scrape of metrics.scrapes) {
      if (!scrape.ok) {
        failures.push(`metrics ${scrape.url}: ${scrape.reason ?? "unavailable"}`);
      }
    }

    for (const family of REQUIRED_METRIC_FAMILIES) {
      if (!metrics.families.includes(family)) {
        failures.push(`metrics ${family}: never reported`);
      }
    }
  }

  for (const entry of metrics.variants) {
    if (entry.variants > thresholds.variantBudget) {
      failures.push(
        `variants ${entry.route}: ${entry.variants} exceeds the budget of ${thresholds.variantBudget}`,
      );
    }
  }

  return failures;
}

export interface WorkerInput {
  readonly config: LoadConfig;
  /** This thread's share of the users. */
  readonly users: LoadUsers;
  readonly startAt: number;
  readonly measureFrom: number;
  readonly stopAt: number;
}

/** Splits users across threads, keeping the totals exact. */
export function splitUsers(users: LoadUsers, threads: number): LoadUsers[] {
  const share = (total: number, index: number): number =>
    Math.floor(total / threads) + (index < total % threads ? 1 : 0);

  return Array.from({ length: threads }, (_, index) => ({
    guests: share(users.guests, index),
    cdnGuests: share(users.cdnGuests, index),
    members: share(users.members, index),
    sseClients: share(users.sseClients, index),
    writesPerSecond: users.writesPerSecond / threads,
  }));
}

/** Runs the load test across worker threads and evaluates it. */
export async function runLoadTest(
  config: LoadConfig,
  thresholds: LoadThresholds = CAPACITY_THRESHOLDS,
): Promise<LoadReport> {
  const threads = Math.max(1, config.threads);
  const startedAt = new Date();
  const startAt = Date.now() + 250;
  const measureFrom = startAt + (config.warmupMs ?? 0);
  const stopAt = measureFrom + config.durationMs;
  const shares = splitUsers(config.users, threads);
  const observations: MetricsObservation[] = [];
  const poll = setInterval(() => {
    void observeMetrics(config.metricsUrls).then((observation) => {
      observations.push(observation);
    });
  }, 5_000);

  try {
    const results = await Promise.all(
      shares.map(
        (users) =>
          new Promise<WorkerResult>((resolve, reject) => {
            const worker = new Worker(new URL("./load-worker.ts", import.meta.url).href);
            worker.onmessage = (event: MessageEvent<WorkerResult>) => {
              resolve(event.data);
              worker.terminate();
            };
            worker.onerror = (event) => {
              reject(new Error(`load worker failed: ${event.message}`));
              worker.terminate();
            };
            worker.postMessage({
              config,
              users,
              startAt,
              measureFrom,
              stopAt,
            } satisfies WorkerInput);
          }),
      ),
    );
    observations.push(await observeMetrics(config.metricsUrls));
    const merged = mergeResults(results, config.durationMs);
    const metrics = mergeObservations(observations);
    const failures = evaluateLoad(merged.routes, merged.sse, metrics, thresholds, {
      writesPerSecond: config.users.writesPerSecond,
      sseClients: config.users.sseClients,
    });

    return {
      startedAt: startedAt.toISOString(),
      durationMs: config.durationMs,
      routes: merged.routes,
      sse: merged.sse,
      metrics,
      failures,
      passed: failures.length === 0,
    };
  } finally {
    clearInterval(poll);
  }
}

export function formatLoadReport(report: LoadReport): string {
  const lines = [
    `load test ${report.startedAt} (${Math.round(report.durationMs / 1_000)} s): ${
      report.passed ? "PASS" : "FAIL"
    }`,
    "role       route                                   count  errors   p50     p95     p99    req/s",
  ];

  for (const route of report.routes) {
    lines.push(
      [
        route.role.padEnd(10),
        route.route.slice(0, 38).padEnd(39),
        String(route.count).padStart(6),
        String(route.errors).padStart(7),
        route.p50.toFixed(1).padStart(7),
        route.p95.toFixed(1).padStart(7),
        route.p99.toFixed(1).padStart(7),
        route.perSecond.toFixed(1).padStart(8),
      ].join(" "),
    );
  }

  lines.push(
    `sse streams: ${report.sse.opened} opened, ${report.sse.failed} failed`,
    `max queue lag: ${report.metrics.maxQueueLagSeconds.toFixed(1)} s${
      report.metrics.laggingQueue === null ? "" : ` (${report.metrics.laggingQueue})`
    }`,
  );

  for (const failure of report.failures) {
    lines.push(`FAIL ${failure}`);
  }

  return lines.join("\n");
}
