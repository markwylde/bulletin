import { afterEach, describe, expect, test } from "bun:test";
import { startService } from "./server.ts";
import {
  currentTraceparent,
  InMemorySpanExporter,
  initTracing,
  OtlpHttpSpanExporter,
  otlpTracesUrl,
  parseTraceparent,
  SpanKind,
  traceHeaders,
  traceJobData,
  withSpan,
} from "./tracing.ts";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

afterEach(() => {
  initTracing({ service: "test", exporter: null });
});

describe("tracing", () => {
  test("parses and rejects traceparent values", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-00f067aa0ba902b7-01`)).toMatchObject({
      traceId: TRACE_ID,
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      isRemote: true,
    });
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
  });

  test("nested spans share the trace and link parents", async () => {
    const exporter = new InMemorySpanExporter();
    initTracing({ service: "test", exporter });

    await withSpan("outer", async () => {
      await withSpan("inner", async () => {
        expect(currentTraceparent()).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        expect(traceJobData().traceparent).toBe(currentTraceparent() ?? "");
        expect(traceHeaders({ a: "b" }).get("traceparent")).toBe(currentTraceparent());
      });
    });

    const [inner, outer] = exporter.spans;
    expect(inner?.name).toBe("inner");
    expect(outer?.parentSpanId).toBeNull();
    expect(inner?.parentSpanId).toBe(outer?.spanId ?? "");
    expect(inner?.traceId).toBe(outer?.traceId ?? "");
    expect(currentTraceparent()).toBeNull();
  });

  test("a job continues the traceparent it carries and records failures", async () => {
    const exporter = new InMemorySpanExporter();
    initTracing({ service: "test", exporter });

    await expect(
      withSpan(
        "job",
        () => {
          throw new Error("boom");
        },
        { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01`, kind: SpanKind.CONSUMER },
      ),
    ).rejects.toThrow("boom");

    const [span] = exporter.spans;
    expect(span?.traceId).toBe(TRACE_ID);
    expect(span?.parentSpanId).toBe("00f067aa0ba902b7");
    expect(span?.status.code).toBe(2);
    expect(span?.events[0]?.name).toBe("exception");
  });

  test("the server span continues an incoming traceparent", async () => {
    const exporter = new InMemorySpanExporter();
    initTracing({ service: "test", exporter });
    const service = await startService({
      service: "plugin-host",
      hostname: "127.0.0.1",
      port: 0,
      installSignalHandlers: false,
      fetch: () => new Response("ok"),
    });

    try {
      await fetch(`http://127.0.0.1:${service.server.port}/internal/filter`, {
        headers: { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` },
      });
    } finally {
      await service.shutdown();
    }

    const span = exporter.spans.find((entry) => entry.kind === SpanKind.SERVER);
    expect(span?.traceId).toBe(TRACE_ID);
    expect(span?.parentSpanId).toBe("00f067aa0ba902b7");
    expect(span?.attributes["http.route"]).toBe("/internal/filter");
  });

  test("exports OTLP/HTTP JSON when an endpoint is configured", async () => {
    expect(otlpTracesUrl({})).toBeNull();
    expect(otlpTracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" })).toBe(
      "http://collector:4318/v1/traces",
    );

    const bodies: unknown[] = [];
    const collector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        bodies.push(await request.json());
        return new Response("{}");
      },
    });
    const exporter = new OtlpHttpSpanExporter({
      url: `http://127.0.0.1:${collector.port}/v1/traces`,
      flushIntervalMs: 60_000,
    });
    initTracing({ service: "otlp-test", exporter });

    try {
      await withSpan("exported", () => undefined, { attributes: { "bulletin.id": 7 } });
      await exporter.shutdown();
    } finally {
      collector.stop(true);
    }

    const body = bodies[0] as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeSpans: Array<{ spans: Array<{ name: string; kind: number }> }>;
      }>;
    };
    const resource = body.resourceSpans[0];
    expect(resource?.resource.attributes[0]?.value.stringValue).toBe("otlp-test");
    expect(resource?.scopeSpans[0]?.spans[0]).toMatchObject({ name: "exported", kind: 1 });
  });

  test("records nothing without an exporter but still forwards trace context", async () => {
    initTracing({ service: "test", env: {} });

    await withSpan(
      "untraced",
      () => {
        expect(currentTraceparent()).toContain(TRACE_ID);
      },
      { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` },
    );
  });
});
