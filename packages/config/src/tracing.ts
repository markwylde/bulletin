/**
 * OpenTelemetry tracing (ADR 0020) on `@opentelemetry/api`, with a small in-repo SDK: an
 * AsyncLocalStorage context manager, the W3C `traceparent` propagator, a sampling-everything
 * tracer and an OTLP/HTTP (JSON) exporter. Tracing is off unless an OTLP endpoint is configured
 * (or a test installs an exporter); with it off, an incoming `traceparent` is still passed on,
 * so a trace that starts elsewhere stays linked.
 *
 * Trace IDs travel with work: HTTP headers (to plugin-host), the outbox row (`core.events.
 * trace_parent`) and pg-boss job data (`traceparent`). They are random identifiers, never
 * personal data (ADR 0011, 0012).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Attributes,
  type AttributeValue,
  type Context,
  type ContextManager,
  context,
  type Exception,
  isSpanContextValid,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  SpanKind,
  type SpanOptions,
  type SpanStatus,
  SpanStatusCode,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  type TimeInput,
  type Tracer,
  type TracerProvider,
  trace,
} from "@opentelemetry/api";

export { SpanKind, SpanStatusCode };

const TRACEPARENT = "traceparent";
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A span after `end()`, as exporters receive it. */
export interface FinishedSpan {
  readonly service: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly startTimeMs: number;
  readonly endTimeMs: number;
  readonly attributes: Readonly<Attributes>;
  readonly status: SpanStatus;
  readonly events: ReadonlyArray<{ name: string; timeMs: number; attributes?: Attributes }>;
  readonly links: readonly Link[];
}

export interface SpanExporter {
  export(spans: readonly FinishedSpan[]): void | Promise<void>;
  shutdown?(): Promise<void>;
}

/** Keeps finished spans in memory (tests). */
export class InMemorySpanExporter implements SpanExporter {
  readonly spans: FinishedSpan[] = [];

  export(spans: readonly FinishedSpan[]): void {
    this.spans.push(...spans);
  }

  reset(): void {
    this.spans.length = 0;
  }
}

function hex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function toMs(time: TimeInput | undefined): number {
  if (time === undefined) {
    return performance.timeOrigin + performance.now();
  }

  if (typeof time === "number") {
    // Values below a plausible epoch are performance.now() style offsets.
    return time < 1e12 ? performance.timeOrigin + time : time;
  }

  if (time instanceof Date) {
    return time.getTime();
  }

  return time[0] * 1_000 + time[1] / 1e6;
}

class AsyncLocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(ctx, () => fn.call(thisArg, ...args));
  }

  bind<T>(ctx: Context, target: T): T {
    if (typeof target !== "function") {
      return target;
    }

    const manager = this;
    const fn = target as unknown as (...args: unknown[]) => unknown;

    return function bound(this: unknown, ...args: unknown[]) {
      return manager.with(ctx, () => fn.apply(this, args));
    } as unknown as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.#storage.disable();
    return this;
  }
}

/** W3C Trace Context (`traceparent` only; Bulletin sends no `tracestate`). */
export class W3CTraceContextPropagator implements TextMapPropagator {
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = trace.getSpanContext(ctx);

    if (spanContext === undefined || !isSpanContextValid(spanContext)) {
      return;
    }

    setter.set(carrier, TRACEPARENT, formatTraceparent(spanContext));
  }

  extract(ctx: Context, carrier: unknown, getter: TextMapGetter): Context {
    const raw = getter.get(carrier, TRACEPARENT);
    const value = Array.isArray(raw) ? raw[0] : raw;
    const parsed = value === undefined ? null : parseTraceparent(value);

    return parsed === null ? ctx : trace.setSpanContext(ctx, parsed);
  }

  fields(): string[] {
    return [TRACEPARENT];
  }
}

export function formatTraceparent(spanContext: SpanContext): string {
  return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
    .toString(16)
    .padStart(2, "0")}`;
}

export function parseTraceparent(value: string): SpanContext | null {
  const match = TRACEPARENT_PATTERN.exec(value.trim().toLowerCase());

  if (match === null) {
    return null;
  }

  const [, traceId = "", spanId = "", flags = "00"] = match;
  const spanContext: SpanContext = {
    traceId,
    spanId,
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
  };

  return isSpanContextValid(spanContext) ? spanContext : null;
}

class RecordingSpan implements Span {
  readonly #context: SpanContext;
  readonly #parentSpanId: string | null;
  readonly #kind: SpanKind;
  readonly #startTimeMs: number;
  readonly #attributes: Attributes;
  readonly #events: Array<{ name: string; timeMs: number; attributes?: Attributes }> = [];
  readonly #links: Link[];
  readonly #onEnd: (span: FinishedSpan) => void;
  readonly #service: string;
  #name: string;
  #status: SpanStatus = { code: SpanStatusCode.UNSET };
  #ended = false;

  constructor(options: {
    readonly service: string;
    readonly name: string;
    readonly context: SpanContext;
    readonly parentSpanId: string | null;
    readonly kind: SpanKind;
    readonly startTime?: TimeInput;
    readonly attributes?: Attributes;
    readonly links?: readonly Link[];
    readonly onEnd: (span: FinishedSpan) => void;
  }) {
    this.#service = options.service;
    this.#name = options.name;
    this.#context = options.context;
    this.#parentSpanId = options.parentSpanId;
    this.#kind = options.kind;
    this.#startTimeMs = toMs(options.startTime);
    this.#attributes = { ...options.attributes };
    this.#links = [...(options.links ?? [])];
    this.#onEnd = options.onEnd;
  }

  spanContext(): SpanContext {
    return this.#context;
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (!this.#ended) {
      this.#attributes[key] = value;
    }
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        this.setAttribute(key, value);
      }
    }
    return this;
  }

  addEvent(
    name: string,
    attributesOrStartTime?: Attributes | TimeInput,
    startTime?: TimeInput,
  ): this {
    const isTime =
      typeof attributesOrStartTime === "number" ||
      attributesOrStartTime instanceof Date ||
      Array.isArray(attributesOrStartTime);
    this.#events.push({
      name,
      timeMs: toMs(isTime ? (attributesOrStartTime as TimeInput) : startTime),
      ...(isTime || attributesOrStartTime === undefined
        ? {}
        : { attributes: attributesOrStartTime as Attributes }),
    });
    return this;
  }

  addLink(link: Link): this {
    this.#links.push(link);
    return this;
  }

  addLinks(links: Link[]): this {
    this.#links.push(...links);
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.#status = status;
    return this;
  }

  updateName(name: string): this {
    this.#name = name;
    return this;
  }

  end(endTime?: TimeInput): void {
    if (this.#ended) {
      return;
    }

    this.#ended = true;
    this.#onEnd({
      service: this.#service,
      name: this.#name,
      kind: this.#kind,
      traceId: this.#context.traceId,
      spanId: this.#context.spanId,
      parentSpanId: this.#parentSpanId,
      startTimeMs: this.#startTimeMs,
      endTimeMs: toMs(endTime),
      attributes: { ...this.#attributes },
      status: this.#status,
      events: [...this.#events],
      links: [...this.#links],
    });
  }

  isRecording(): boolean {
    return !this.#ended;
  }

  recordException(exception: Exception, time?: TimeInput): void {
    const message =
      typeof exception === "string"
        ? exception
        : exception instanceof Error
          ? exception.message
          : String(exception.message ?? "");
    const type =
      typeof exception === "string"
        ? "Error"
        : exception instanceof Error
          ? exception.name
          : String(exception.name ?? "Error");
    this.addEvent("exception", { "exception.type": type, "exception.message": message }, time);
  }
}

type ActiveFn<F> = (span: Span) => F;

class BulletinTracer implements Tracer {
  constructor(readonly provider: BulletinTracerProvider) {}

  startSpan(name: string, options: SpanOptions = {}, ctx: Context = context.active()): Span {
    const parent = options.root === true ? undefined : trace.getSpanContext(ctx);
    const validParent = parent !== undefined && isSpanContextValid(parent) ? parent : undefined;
    const spanContext: SpanContext = {
      traceId: validParent?.traceId ?? hex(16),
      spanId: hex(8),
      traceFlags: 1,
    };

    return new RecordingSpan({
      service: this.provider.service,
      name,
      context: spanContext,
      parentSpanId: validParent?.spanId ?? null,
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
      ...(options.links === undefined ? {} : { links: options.links }),
      onEnd: (span) => this.provider.onEnd(span),
    });
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    ctx: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F>(
    name: string,
    ...args: [ActiveFn<F>] | [SpanOptions, ActiveFn<F>] | [SpanOptions, Context, ActiveFn<F>]
  ): F {
    const fn = args[args.length - 1] as ActiveFn<F>;
    const options = (args.length >= 2 ? args[0] : {}) as SpanOptions;
    const parent = (args.length === 3 ? args[1] : context.active()) as Context;
    const span = this.startSpan(name, options, parent);

    return context.with(trace.setSpan(parent, span), fn, undefined, span);
  }
}

class BulletinTracerProvider implements TracerProvider {
  service = "bulletin";
  exporter: SpanExporter | null = null;
  readonly #tracer = new BulletinTracer(this);

  getTracer(): Tracer {
    return this.#tracer;
  }

  onEnd(span: FinishedSpan): void {
    if (this.exporter === null) {
      return;
    }

    try {
      void Promise.resolve(this.exporter.export([span])).catch(() => undefined);
    } catch {
      // Exporting is best effort; it must never fail the traced work.
    }
  }
}

export interface OtlpExporterOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly flushIntervalMs?: number;
  readonly maxBatch?: number;
  readonly fetchImpl?: typeof fetch;
}

function otlpValue(value: AttributeValue | undefined): Record<string, unknown> {
  if (typeof value === "string") {
    return { stringValue: value };
  }

  if (typeof value === "boolean") {
    return { boolValue: value };
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }

  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((entry) => otlpValue(entry as AttributeValue)),
      },
    };
  }

  return { stringValue: "" };
}

function otlpAttributes(attributes: Attributes): Array<Record<string, unknown>> {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms * 1_000)) * 1_000n).toString();
}

/** The OTLP/HTTP JSON request body for a batch of spans. */
export function otlpTraceRequest(spans: readonly FinishedSpan[]): Record<string, unknown> {
  const byService = new Map<string, FinishedSpan[]>();

  for (const span of spans) {
    byService.set(span.service, [...(byService.get(span.service) ?? []), span]);
  }

  return {
    resourceSpans: [...byService].map(([service, serviceSpans]) => ({
      resource: { attributes: otlpAttributes({ "service.name": service }) },
      scopeSpans: [
        {
          scope: { name: "bulletin" },
          spans: serviceSpans.map((span) => ({
            traceId: span.traceId,
            spanId: span.spanId,
            ...(span.parentSpanId === null ? {} : { parentSpanId: span.parentSpanId }),
            name: span.name,
            // OTLP numbers span kinds from 1 (INTERNAL); the API numbers them from 0.
            kind: span.kind + 1,
            startTimeUnixNano: nanos(span.startTimeMs),
            endTimeUnixNano: nanos(span.endTimeMs),
            attributes: otlpAttributes(span.attributes),
            events: span.events.map((event) => ({
              name: event.name,
              timeUnixNano: nanos(event.timeMs),
              attributes: otlpAttributes(event.attributes ?? {}),
            })),
            links: span.links.map((link) => ({
              traceId: link.context.traceId,
              spanId: link.context.spanId,
              attributes: otlpAttributes(link.attributes ?? {}),
            })),
            status: {
              code: span.status.code,
              ...(span.status.message === undefined ? {} : { message: span.status.message }),
            },
          })),
        },
      ],
    })),
  };
}

/** Batches spans and posts them to an OTLP/HTTP collector as JSON. */
export class OtlpHttpSpanExporter implements SpanExporter {
  readonly #options: OtlpExporterOptions;
  readonly #buffer: FinishedSpan[] = [];
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(options: OtlpExporterOptions) {
    this.#options = options;
    this.#timer = setInterval(() => {
      void this.flush();
    }, options.flushIntervalMs ?? 2_000);
    this.#timer.unref?.();
  }

  export(spans: readonly FinishedSpan[]): void {
    this.#buffer.push(...spans);

    if (this.#buffer.length >= (this.#options.maxBatch ?? 256)) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) {
      return;
    }

    const batch = this.#buffer.splice(0, this.#buffer.length);
    const request = this.#options.fetchImpl ?? fetch;

    try {
      await request(this.#options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#options.headers },
        body: JSON.stringify(otlpTraceRequest(batch)),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // A collector outage drops spans; it never slows down requests.
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.#timer);
    await this.flush();
  }
}

const provider = new BulletinTracerProvider();
let globalsInstalled = false;

function installGlobals(): void {
  if (globalsInstalled) {
    return;
  }

  globalsInstalled = true;
  context.setGlobalContextManager(new AsyncLocalContextManager());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
}

// Context and propagation are always on, so an incoming traceparent is forwarded even when
// this process does not record spans.
installGlobals();

export interface TracingOptions {
  readonly service: string;
  /** Overrides the OTLP exporter (tests install an {@link InMemorySpanExporter}). */
  readonly exporter?: SpanExporter | null;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The OTLP traces URL from the standard OpenTelemetry environment variables, if any. */
export function otlpTracesUrl(env: Readonly<Record<string, string | undefined>>): string | null {
  const explicit = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();

  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }

  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base === undefined || base === "" ? null : `${base.replace(/\/$/, "")}/v1/traces`;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const entry of (raw ?? "").split(",")) {
    const separator = entry.indexOf("=");

    if (separator > 0) {
      headers[entry.slice(0, separator).trim()] = decodeURIComponent(
        entry.slice(separator + 1).trim(),
      );
    }
  }

  return headers;
}

/**
 * Enables span recording for this process when an exporter is given or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Safe to call again (tests swap the exporter).
 */
export function initTracing(options: TracingOptions): { readonly enabled: boolean } {
  const env = options.env ?? Bun.env;
  provider.service = env.OTEL_SERVICE_NAME?.trim() || options.service;

  if (options.exporter !== undefined) {
    provider.exporter = options.exporter;
    return { enabled: options.exporter !== null };
  }

  const url = otlpTracesUrl(env);
  provider.exporter =
    url === null
      ? null
      : new OtlpHttpSpanExporter({ url, headers: parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS) });

  return { enabled: provider.exporter !== null };
}

/** Flushes and stops the exporter on shutdown. */
export async function shutdownTracing(): Promise<void> {
  const exporter = provider.exporter;
  provider.exporter = null;
  await exporter?.shutdown?.();
}

export function tracingEnabled(): boolean {
  return provider.exporter !== null;
}

export function tracer(): Tracer {
  return trace.getTracer("bulletin");
}

export interface WithSpanOptions {
  readonly kind?: SpanKind;
  readonly attributes?: Attributes;
  /** A `traceparent` to continue (job data, outbox row); ignored when invalid. */
  readonly traceparent?: string | null;
}

function parentContext(traceparent: string | null | undefined): Context {
  if (traceparent === undefined || traceparent === null) {
    return context.active();
  }

  const parsed = parseTraceparent(traceparent);
  return parsed === null ? context.active() : trace.setSpanContext(ROOT_CONTEXT, parsed);
}

/** Runs `fn` inside a new active span; errors are recorded and rethrown. */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options: WithSpanOptions = {},
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
    },
    parentContext(options.traceparent),
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Runs a request handler in a SERVER span that continues the caller's `traceparent`. */
export function withServerSpan<T>(
  request: Request,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Attributes = {},
): Promise<T> {
  return withSpan(name, fn, {
    kind: SpanKind.SERVER,
    traceparent: request.headers.get(TRACEPARENT),
    attributes: { "http.request.method": request.method, ...attributes },
  });
}

/** The active span as a `traceparent`, or `null` outside a trace. */
export function currentTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier[TRACEPARENT] ?? null;
}

/** `{ traceparent }` for pg-boss job data, or `{}` outside a trace. */
export function traceJobData(): { traceparent?: string } {
  const traceparent = currentTraceparent();
  return traceparent === null ? {} : { traceparent };
}

/** Copies headers and adds the active `traceparent` (calls to plugin-host and other services). */
export function traceHeaders(headers?: RequestInit["headers"]): Headers {
  const result = new Headers(headers);
  const traceparent = currentTraceparent();

  if (traceparent !== null) {
    result.set(TRACEPARENT, traceparent);
  }

  return result;
}

/** `fetch` in a CLIENT span that forwards `traceparent`. */
export function tracedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);

  return withSpan(
    `HTTP ${init.method ?? "GET"} ${target.host}`,
    async (span) => {
      const response = await fetch(url, { ...init, headers: traceHeaders(init.headers) });
      span.setAttribute("http.response.status_code", response.status);
      return response;
    },
    {
      kind: SpanKind.CLIENT,
      attributes: { "http.request.method": init.method ?? "GET", "server.address": target.host },
    },
  );
}
