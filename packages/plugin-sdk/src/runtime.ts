import type {
  ContentExtensionInput,
  EnricherInput,
  EventDelivery,
  FilterInput,
  JobDelivery,
  PluginDefinition,
  RouteRequest,
  RouteResponse,
  VetInput,
} from "./hooks.ts";
import {
  encodeFrame,
  FrameDecoder,
  isRequest,
  isResponse,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.ts";
import { SDK_VERSION } from "./semver.ts";

export interface BrokerConnectOptions {
  readonly socketPath: string;
  readonly pluginId: string;
  readonly sdkVersion?: string;
  /** Per-request deadline for plugin→core calls. */
  readonly timeoutMs?: number;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export type RequestHandler = (request: JsonRpcRequest) => Promise<unknown>;

const DEFAULT_CALL_TIMEOUT_MS = 5_000;

/** The plugin side of the broker protocol. */
export class BrokerClient {
  readonly #socket: Bun.Socket;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<JsonRpcId, PendingCall>();
  readonly #timeoutMs: number;
  #nextId = 0;
  #handler: RequestHandler | undefined;

  constructor(socket: Bun.Socket, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
  }

  onRequest(handler: RequestHandler): void {
    this.#handler = handler;
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = this.#timeoutMs): Promise<T> {
    const id = ++this.#nextId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Broker call ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      this.#write({ jsonrpc: "2.0", id, method, params: params ?? null });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params: params ?? null });
  }

  receive(data: Uint8Array): void {
    let messages: unknown[];

    try {
      messages = this.#decoder.push(data);
    } catch {
      this.close();
      return;
    }

    for (const message of messages) {
      if (isResponse(message)) {
        this.#settle(message);
        continue;
      }

      if (isRequest(message)) {
        void this.#dispatch(message);
      }
    }
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Broker connection closed"));
    }

    this.#pending.clear();
    this.#socket.end();
  }

  async #dispatch(request: JsonRpcRequest): Promise<void> {
    if (this.#handler === undefined) {
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "No request handler registered" },
      });
      return;
    }

    try {
      const result = await this.#handler(request);
      this.#write({ jsonrpc: "2.0", id: request.id, result: result ?? null });
    } catch (error) {
      this.#write({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  #settle(response: JsonRpcResponse): void {
    if (response.id === null) {
      return;
    }

    const pending = this.#pending.get(response.id);

    if (pending === undefined) {
      return;
    }

    this.#pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.error !== undefined) {
      pending.reject(new Error(response.error.message));
      return;
    }

    pending.resolve(response.result);
  }

  #write(message: unknown): void {
    this.#socket.write(encodeFrame(message));
  }
}

/** Connects to a broker socket and completes the `hello` handshake. */
export async function connectBroker(options: BrokerConnectOptions): Promise<BrokerClient> {
  let decoder: BrokerClient | undefined;
  const socket = await Bun.connect({
    unix: options.socketPath,
    socket: {
      open() {},
      data(_socket, data) {
        decoder?.receive(data);
      },
      error() {},
      close() {},
    },
  });
  const client = new BrokerClient(socket, options.timeoutMs);
  decoder = client;
  client.notify("hello", {
    pluginId: options.pluginId,
    sdkVersion: options.sdkVersion ?? SDK_VERSION,
  });
  return client;
}

export interface PluginServer {
  readonly client: BrokerClient;
  readonly close: () => void;
  readonly description: Readonly<Record<string, unknown>>;
}

function requireParams<T>(params: unknown): T {
  return (params ?? {}) as T;
}

function describe(definition: PluginDefinition): Record<string, unknown> {
  return {
    id: definition.id,
    version: definition.version ?? "0.0.0",
    enrichers: Object.values(definition.hooks.enrichers ?? {}).map((entry) => ({
      fields: entry.fields,
      deps: entry.deps ?? [],
    })),
    filters: Object.keys(definition.hooks.filters ?? {}),
    vetoes: Object.entries(definition.hooks.vetoes ?? {}).map(([hook, veto]) => ({
      hook,
      reasonKey: veto.reasonKey,
      failMode: veto.failMode ?? "open",
    })),
    events: Object.keys(definition.events ?? {}),
    jobs: Object.keys(definition.jobs ?? {}),
    routes: Object.keys(definition.routes ?? {}),
    contentExtensions: Object.keys(definition.contentExtensions ?? {}),
    clientApps: definition.clientApps ?? [],
  };
}

async function handleRequest(
  definition: PluginDefinition,
  request: JsonRpcRequest,
): Promise<unknown> {
  const params = request.params; // dispatch below narrows by method

  switch (request.method) {
    case "plugin.describe":
      return describe(definition);

    case "hook.enrich": {
      const input = requireParams<EnricherInput & { hook: string }>(params);
      const handler = Object.entries(definition.hooks.enrichers ?? {}).find(
        ([hook]) => hook === input.hook,
      )?.[1];

      if (handler === undefined) {
        return { fields: {}, tags: [] };
      }

      const result = await handler.handler(input);
      return { fields: result.fields, tags: result.tags ?? [] };
    }

    case "hook.filter": {
      const input = requireParams<FilterInput & { hook: string }>(params);
      const handler = Object.entries(definition.hooks.filters ?? {}).find(
        ([hook]) => hook === input.hook,
      )?.[1];

      if (handler === undefined) {
        return { content: input.content };
      }

      return { content: await handler.handler(input) };
    }

    case "hook.veto": {
      const input = requireParams<VetInput & { hook: string }>(params);
      const handler = Object.entries(definition.hooks.vetoes ?? {}).find(
        ([hook]) => hook === input.hook,
      )?.[1];

      if (handler === undefined) {
        return { allow: true };
      }

      return handler.handler(input);
    }

    case "content.extend": {
      const input = requireParams<ContentExtensionInput>(params);
      const handler = definition.contentExtensions?.[input.syntax];

      if (handler === undefined) {
        return { html: "" };
      }

      return handler(input);
    }

    case "event.deliver": {
      const event = requireParams<EventDelivery>(params);
      const handler = definition.events?.[event.type];

      if (handler === undefined) {
        return null;
      }

      await handler(event);
      return null;
    }

    case "job.run": {
      const job = requireParams<JobDelivery>(params);
      const handler = definition.jobs?.[job.name];

      if (handler === undefined) {
        return null;
      }

      await handler(job);
      return null;
    }

    case "route.request":
    case "bridge.request": {
      const route = requireParams<RouteRequest & { path: string }>(params);
      const handler = definition.routes?.[route.path];

      if (handler === undefined) {
        const missing: RouteResponse = { status: 404, body: "Not found" };
        return missing;
      }

      return handler(route);
    }

    case "gdpr.export": {
      const subject = requireParams<{ memberId: string }>(params);
      return definition.gdpr?.export === undefined ? { data: {} } : definition.gdpr.export(subject);
    }

    case "gdpr.erase": {
      const subject = requireParams<{ memberId: string }>(params);
      await definition.gdpr?.erase?.(subject);
      return null;
    }

    default:
      throw new Error(`Unknown hook method: ${request.method}`);
  }
}

/** Starts a plugin server: connects to the broker and serves hook dispatches. */
export async function servePlugin(
  definition: PluginDefinition,
  options: Omit<BrokerConnectOptions, "pluginId"> & { readonly pluginId?: string },
): Promise<PluginServer> {
  const client = await connectBroker({
    socketPath: options.socketPath,
    pluginId: options.pluginId ?? definition.id,
    ...(options.sdkVersion === undefined ? {} : { sdkVersion: options.sdkVersion }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  client.onRequest((request) => handleRequest(definition, request));

  return {
    client,
    close: () => client.close(),
    description: describe(definition),
  };
}
