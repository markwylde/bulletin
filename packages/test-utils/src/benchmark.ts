/**
 * The latency benchmark harness (ADR 0006, task 7.1). Later changes register their routes in
 * `benchmark-routes.ts`; the runner measures cached guest, member and cold TTFB against the
 * seeded stack and fails when an ADR 0006 threshold is exceeded.
 */

/** ADR 0006 p95 targets on the seeded dataset (milliseconds). */
export interface LatencyThresholds {
  readonly guestP95Ms: number;
  readonly memberP95Ms: number;
  readonly coldP95Ms: number;
}

export const DEFAULT_LATENCY_THRESHOLDS: LatencyThresholds = {
  guestP95Ms: 30,
  memberP95Ms: 80,
  coldP95Ms: 200,
};

export interface RouteBenchmark {
  readonly name: string;
  /** A page a guest may load from the edge cache. */
  readonly guestUrl: string;
  /** The same page as a member, using the benchmark session cookie. */
  readonly memberUrl: string;
  /** A URL that must miss every cache layer; the nonce is unique per sample. */
  readonly coldUrl: (nonce: string) => string;
  readonly thresholds?: Partial<LatencyThresholds>;
}

export type BenchmarkFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface BenchmarkOptions {
  readonly baseUrl: string;
  /** `name=value` session cookie for the member samples. */
  readonly memberCookie: string;
  readonly samples?: number;
  readonly warmup?: number;
  readonly thresholds?: LatencyThresholds;
  readonly fetchImpl?: BenchmarkFetch;
}

export interface Timing {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
}

export interface RouteBenchmarkResult {
  readonly route: string;
  readonly guest: Timing;
  readonly member: Timing;
  readonly cold: Timing;
  readonly failures: readonly string[];
  readonly passed: boolean;
}

interface Sample {
  readonly ms: number;
  readonly cache: string | null;
  readonly body: string;
  readonly status: number;
}

const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUP = 5;

function timing(name: string, samples: readonly Sample[]): Timing {
  if (samples.length === 0) {
    throw new Error(`No ${name} samples were measured`);
  }

  const sorted = samples.map((sample) => sample.ms).sort((left, right) => left - right);
  const at = (percentile: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length))] ?? 0;
  const round = (value: number): number => Math.round(value * 100) / 100;

  return {
    samples: sorted.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    min: round(sorted[0] ?? 0),
    max: round(sorted[sorted.length - 1] ?? 0),
  };
}

async function request(
  fetchImpl: BenchmarkFetch,
  baseUrl: string,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<Sample> {
  const started = performance.now();
  const response = await fetchImpl(`${baseUrl}${path}`, { headers, redirect: "manual" });
  // TTFB is measured at the response headers; the body is drained afterwards.
  const ms = performance.now() - started;
  const body = await response.text();

  return { ms, cache: response.headers.get("x-cache"), body, status: response.status };
}

function checkCached(
  label: string,
  samples: readonly Sample[],
  expected: "HIT" | "MISS",
): readonly string[] {
  const failures: string[] = [];
  const observed = samples.filter((sample) => sample.cache !== null);

  if (observed.length === 0) {
    // Production builds do not expose the dev diagnostic header.
    return failures;
  }

  for (const sample of observed) {
    if (sample.cache !== expected) {
      failures.push(
        `${label} sample reported X-Cache ${sample.cache ?? "(none)"}, expected ${expected}`,
      );
      break;
    }
  }

  return failures;
}

function checkStatus(label: string, samples: readonly Sample[]): readonly string[] {
  const bad = samples.find((sample) => sample.status !== 200);

  return bad === undefined ? [] : [`${label} sample returned HTTP ${bad.status}, expected 200`];
}

export async function runRouteBenchmark(
  route: RouteBenchmark,
  options: BenchmarkOptions,
): Promise<RouteBenchmarkResult> {
  const fetchImpl: BenchmarkFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const samples = options.samples ?? DEFAULT_SAMPLES;
  const warmup = options.warmup ?? DEFAULT_WARMUP;
  const thresholds: LatencyThresholds = {
    ...DEFAULT_LATENCY_THRESHOLDS,
    ...options.thresholds,
    ...route.thresholds,
  };
  const failures: string[] = [];
  const guestHeaders = { accept: "text/html" };
  const memberHeaders = { accept: "text/html", cookie: options.memberCookie };

  for (let index = 0; index < warmup; index += 1) {
    await request(fetchImpl, options.baseUrl, route.guestUrl, guestHeaders);
    await request(fetchImpl, options.baseUrl, route.memberUrl, memberHeaders);
  }

  const guest = [];

  for (let index = 0; index < samples; index += 1) {
    guest.push(await request(fetchImpl, options.baseUrl, route.guestUrl, guestHeaders));
  }

  const member = [];

  for (let index = 0; index < samples; index += 1) {
    member.push(await request(fetchImpl, options.baseUrl, route.memberUrl, memberHeaders));
  }

  const cold = [];

  for (let index = 0; index < samples; index += 1) {
    const nonce = `${String(Date.now()).slice(-8)}${String(index).padStart(2, "0")}`;
    cold.push(await request(fetchImpl, options.baseUrl, route.coldUrl(nonce), guestHeaders));
  }

  const guestTiming = timing("guest", guest);
  const memberTiming = timing("member", member);
  const coldTiming = timing("cold", cold);

  failures.push(...checkStatus("guest", guest), ...checkStatus("member", member));
  failures.push(...checkStatus("cold", cold));
  failures.push(...checkCached("guest", guest, "HIT"));
  failures.push(...checkCached("member", member, "HIT"));
  failures.push(...checkCached("cold", cold, "MISS"));

  if (guest.some((sample) => !sample.body.includes('data-visitor="guest"'))) {
    failures.push("guest samples did not render the guest page");
  }

  if (member.some((sample) => !sample.body.includes('data-visitor="member"'))) {
    failures.push("member samples did not render the member page (session cookie rejected)");
  }

  if (guestTiming.p95 > thresholds.guestP95Ms) {
    failures.push(`guest p95 ${guestTiming.p95} ms exceeds ${thresholds.guestP95Ms} ms (ADR 0006)`);
  }

  if (memberTiming.p95 > thresholds.memberP95Ms) {
    failures.push(
      `member p95 ${memberTiming.p95} ms exceeds ${thresholds.memberP95Ms} ms (ADR 0006)`,
    );
  }

  if (coldTiming.p95 > thresholds.coldP95Ms) {
    failures.push(`cold p95 ${coldTiming.p95} ms exceeds ${thresholds.coldP95Ms} ms (ADR 0006)`);
  }

  return {
    route: route.name,
    guest: guestTiming,
    member: memberTiming,
    cold: coldTiming,
    failures,
    passed: failures.length === 0,
  };
}

export async function runBenchmarks(
  routes: readonly RouteBenchmark[],
  options: BenchmarkOptions,
): Promise<readonly RouteBenchmarkResult[]> {
  const results: RouteBenchmarkResult[] = [];

  for (const route of routes) {
    results.push(await runRouteBenchmark(route, options));
  }

  return results;
}

function latency(timing: Timing): string {
  return `${timing.p50}/${timing.p95} ms`;
}

/** A fixed-width table plus one line per failure. */
export function formatBenchmarkResults(results: readonly RouteBenchmarkResult[]): string {
  const lines = [
    "route      guest p50/p95  member p50/p95  cold p50/p95   result",
    ...results.map(
      (result) =>
        `${result.route.padEnd(9)} ${latency(result.guest).padEnd(14)} ` +
        `${latency(result.member).padEnd(15)} ${latency(result.cold).padEnd(14)} ` +
        `${result.passed ? "PASS" : "FAIL"}`,
    ),
  ];

  for (const result of results) {
    for (const failure of result.failures) {
      lines.push(`${result.route}: ${failure}`);
    }
  }

  return lines.join("\n");
}
