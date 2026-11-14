import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CAPACITY_THRESHOLDS,
  evaluateLoad,
  formatLoadReport,
  type LoadConfig,
  mergeObservations,
  mergeResults,
  newSamples,
  observeMetrics,
  percentile,
  recordSample,
  runLoadTest,
  splitUsers,
} from "./load-test.ts";

describe("load test arithmetic", () => {
  test("percentiles come from 0.1 ms buckets", () => {
    const samples = newSamples("guest", "/");

    for (let index = 1; index <= 100; index += 1) {
      recordSample(samples, index, true);
    }

    recordSample(samples, 5, false);
    expect(samples.count).toBe(101);
    expect(samples.errors).toBe(1);
    expect(percentile(samples.buckets, 0.5)).toBe(50);
    expect(percentile(samples.buckets, 0.95)).toBe(95);
  });

  test("users split across threads keep their totals", () => {
    const shares = splitUsers(
      { guests: 10, cdnGuests: 1, members: 3, sseClients: 0, writesPerSecond: 50 },
      4,
    );
    expect(shares.reduce((total, share) => total + share.guests, 0)).toBe(10);
    expect(shares.reduce((total, share) => total + share.members, 0)).toBe(3);
    expect(shares.reduce((total, share) => total + share.writesPerSecond, 0)).toBe(50);
  });

  test("throttled writes, lagging queues and variant blow-ups fail the run", () => {
    const writes = newSamples("writer", "/api/topics/[id]/replies");

    for (let index = 0; index < 100; index += 1) {
      recordSample(writes, 20, index % 2 === 0);
    }

    const merged = mergeResults(
      [{ routes: [writes], sseOpened: 3, sseFailed: 1, sseDropped: 0 }],
      10_000,
    );
    const failures = evaluateLoad(
      merged.routes,
      merged.sse,
      {
        maxQueueLagSeconds: 12,
        laggingQueue: "domain-events",
        variants: [{ route: "/topic/[id]", variants: 200 }],
        scrapes: [{ url: "http://workers:9464/metrics", ok: true }],
        families: ["bulletin_queue_lag_seconds", "bulletin_cache_variants"],
      },
      CAPACITY_THRESHOLDS,
      { writesPerSecond: 50, sseClients: 4 },
    );

    expect(failures).toEqual([
      "error rate 50.00% exceeds 1.00%",
      "writes: 5.0/s sustained, below 50/s",
      "sse: 3 of 4 streams opened",
      "queue domain-events: lag 12.0 s exceeds 5 s",
      "variants /topic/[id]: 200 exceeds the budget of 64",
    ]);
  });
});

describe("load test metrics observations", () => {
  const healthy = [
    'bulletin_queue_lag_seconds{queue="domain-events"} 0.4',
    'bulletin_cache_variants{route="/"} 3',
  ].join("\n");

  function stub(responses: Record<string, () => Response>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      const respond = responses[url];

      if (respond === undefined) {
        throw new TypeError("fetch failed");
      }

      return respond();
    }) as typeof fetch;
  }

  function evaluate(observation: Awaited<ReturnType<typeof observeMetrics>>): string[] {
    return evaluateLoad(
      [],
      { opened: 0, failed: 0, dropped: 0 },
      observation,
      CAPACITY_THRESHOLDS,
      {
        writesPerSecond: 0,
        sseClients: 0,
      },
    );
  }

  test("a healthy scrape passes", async () => {
    const observation = await observeMetrics(
      ["http://a/metrics"],
      stub({ "http://a/metrics": () => new Response(healthy) }),
    );
    expect(evaluate(observation)).toEqual([]);
  });

  test("unreachable or failing endpoints fail the run instead of reading as zero lag", async () => {
    const observation = await observeMetrics(
      ["http://down/metrics", "http://error/metrics"],
      stub({ "http://error/metrics": () => new Response("no", { status: 503 }) }),
    );
    expect(observation.maxQueueLagSeconds).toBe(0);
    expect(evaluate(observation)).toEqual([
      "metrics http://down/metrics: unreachable",
      "metrics http://error/metrics: HTTP 503",
      "metrics bulletin_queue_lag_seconds: never reported",
      "metrics bulletin_cache_variants: never reported",
    ]);
  });

  test("empty and malformed scrapes fail the run", async () => {
    const observation = await observeMetrics(
      ["http://empty/metrics", "http://garbled/metrics"],
      stub({
        "http://empty/metrics": () => new Response("# nothing here\n"),
        "http://garbled/metrics": () =>
          new Response(`${healthy}\nbulletin_queue_lag_seconds{queue="x"} not-a-number`),
      }),
    );
    expect(evaluate(observation)).toEqual([
      "metrics http://empty/metrics: empty",
      "metrics http://garbled/metrics: malformed",
      "metrics bulletin_queue_lag_seconds: never reported",
      "metrics bulletin_cache_variants: never reported",
    ]);
  });

  test("no configured endpoints fail the run", async () => {
    expect(evaluate(await observeMetrics([]))).toEqual(["metrics: no endpoints configured"]);
  });

  test("an endpoint that answered once during the run counts as observed", async () => {
    let up = false;
    const fetchImpl = stub({
      "http://a/metrics": () => (up ? new Response(healthy) : new Response("", { status: 502 })),
    });
    const first = await observeMetrics(["http://a/metrics"], fetchImpl);
    up = true;
    const second = await observeMetrics(["http://a/metrics"], fetchImpl);
    expect(evaluate(first)).toContain("metrics http://a/metrics: HTTP 502");
    expect(evaluate(mergeObservations([first, second]))).toEqual([]);
  });
});

describe("load test against a stand-in origin", () => {
  let server: ReturnType<typeof Bun.serve>;
  let replies = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { pathname } = new URL(request.url);

        if (pathname === "/slow") {
          // The planted latency regression.
          await Bun.sleep(45);
        }

        if (pathname === "/metrics") {
          return new Response(
            [
              'bulletin_queue_lag_seconds{queue="domain-events"} 0.4',
              'bulletin_cache_variants{route="/"} 3',
            ].join("\n"),
          );
        }

        if (pathname === "/api/stream") {
          // A stream the server ends at once, as on a crash or a dropped connection.
          if ((request.headers.get("cookie") ?? "").includes("drop")) {
            return new Response("", { headers: { "content-type": "text/event-stream" } });
          }

          let timer: ReturnType<typeof setInterval> | undefined;
          return new Response(
            new ReadableStream({
              start(controller) {
                timer = setInterval(
                  () => controller.enqueue(new TextEncoder().encode(": hb\n\n")),
                  100,
                );
              },
              cancel() {
                clearInterval(timer);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }

        if (pathname === "/api/auth/session") {
          return Response.json({ csrfToken: "token" });
        }

        if (pathname.endsWith("/replies")) {
          replies += 1;
          return request.headers.get("x-bulletin-csrf") === "token"
            ? Response.json({ ok: true }, { status: 201 })
            : Response.json({ code: "csrf" }, { status: 403 });
        }

        return new Response("<p>ok</p>", { headers: { "content-type": "text/html" } });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function config(guestPaths: readonly string[]): LoadConfig {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    return {
      baseUrl,
      durationMs: 1_500,
      warmupMs: 200,
      thinkMs: 20,
      users: { guests: 4, cdnGuests: 0, members: 2, sseClients: 0, writesPerSecond: 10 },
      guestPaths,
      memberPaths: ["/"],
      overlayContexts: ["board"],
      sessions: [{ cookie: "bl_session=a" }],
      writerSessions: [{ cookie: "bl_session=b" }],
      replyTopicIds: ["1"],
      threads: 2,
      metricsUrls: [`${baseUrl}/metrics`],
    };
  }

  test("passes when every route meets its threshold", async () => {
    const report = await runLoadTest(config(["/", "/fast"]), {
      ...CAPACITY_THRESHOLDS,
      writesPerSecond: 10,
    });

    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.routes.map((route) => `${route.role} ${route.route}`)).toEqual([
      "guest /",
      "guest /fast",
      "member /",
      "member /api/me/overlay",
      "writer /api/topics/[id]/replies",
    ]);
    expect(replies).toBeGreaterThan(10);
    expect(report.metrics.maxQueueLagSeconds).toBe(0.4);
  }, 15_000);

  test("fails on a planted latency regression and names the route", async () => {
    const report = await runLoadTest(config(["/", "/slow"]), {
      ...CAPACITY_THRESHOLDS,
      writesPerSecond: 10,
    });

    expect(report.passed).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/^guest \/slow: p95 \d+\.\d ms exceeds 30 ms$/);
    expect(formatLoadReport(report)).toContain("FAIL guest /slow");
  }, 15_000);

  test("SSE streams must stay open for the whole run", async () => {
    const held = await runLoadTest(
      {
        ...config(["/"]),
        users: { guests: 1, cdnGuests: 0, members: 0, sseClients: 2, writesPerSecond: 0 },
      },
      CAPACITY_THRESHOLDS,
    );
    expect(held.sse).toEqual({ opened: 2, failed: 0, dropped: 0 });
    expect(held.failures).toEqual([]);

    const dropped = await runLoadTest(
      {
        ...config(["/"]),
        users: { guests: 1, cdnGuests: 0, members: 0, sseClients: 2, writesPerSecond: 0 },
        sessions: [{ cookie: "bl_session=drop" }],
      },
      CAPACITY_THRESHOLDS,
    );
    expect(dropped.sse).toEqual({ opened: 2, failed: 0, dropped: 2 });
    expect(dropped.failures).toEqual(["sse: 2 of 2 streams closed before the end of the run"]);
  }, 15_000);
});
