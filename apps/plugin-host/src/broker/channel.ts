import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bulletin/config";
import type { ViewerContext } from "@bulletin/plugin-sdk/hooks";
import {
  DEFAULT_MAX_FRAME_BYTES,
  type DecodedFrame,
  encodeFrame,
  FrameDecoder,
  FrameError,
  failure,
  isRequest,
  isResponse,
  JSON_RPC_ERRORS,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  parseMessage,
  RpcError,
  success,
} from "./protocol.ts";

/** Handshake a plugin sends before any broker request. */
export interface PluginHello {
  readonly pluginId: string;
  readonly sdkVersion: string;
}

/** The broker-side implementation of the RPC methods. */
export interface BrokerHandler {
  handle(request: {
    readonly method: string;
    readonly params: unknown;
    readonly pluginId: string;
    readonly viewer?: ViewerContext;
  }): Promise<unknown>;
}

export interface BrokerChannelOptions {
  readonly socketPath: string;
  readonly logger: Logger;
  readonly handler?: BrokerHandler;
  /** Caps one plugin message and one broker response. */
  readonly maxFrameBytes?: number;
  /** Concurrent plugin connections accepted on the broker socket. */
  readonly maxConnections?: number;
  /** In-flight plus queued requests per connection. */
  readonly maxPendingRequests?: number;
  /** In-flight plus queued decoded payload bytes per connection. */
  readonly maxQueuedBytes?: number;
  /** Unwritten response bytes queued for a slow reader. */
  readonly maxOutboundBytes?: number;
  /** Host-selected identity; a sandbox may never claim another plugin's id. */
  readonly expectedPluginId?: string;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;
const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_PENDING_REQUESTS = 8;
const DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTBOUND_BYTES = 2 * 1024 * 1024;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return value;
}

interface BrokerSocket {
  write(data: Uint8Array): number;
  end(): void;
}

interface PendingBrokerCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  readonly decoder: FrameDecoder;
  pluginId: string | null;
  queue: Promise<void>;
  pending: number;
  queuedBytes: number;
  readonly outbound: Uint8Array[];
  outboundOffset: number;
  outboundBytes: number;
  flushing: boolean;
  readonly calls: Map<JsonRpcId, PendingBrokerCall>;
}

function parseHello(params: unknown): PluginHello | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }

  const record = params as Record<string, unknown>;

  if (
    typeof record.pluginId !== "string" ||
    !PLUGIN_ID_PATTERN.test(record.pluginId) ||
    typeof record.sdkVersion !== "string"
  ) {
    return undefined;
  }

  return { pluginId: record.pluginId, sdkVersion: record.sdkVersion };
}

/**
 * The broker's Unix-socket listener. It speaks length-prefixed JSON-RPC: the first message
 * is a `hello` notification, then the plugin may call the methods implemented by the injected
 * {@link BrokerHandler}. Requests on one connection are handled in order so a plugin cannot
 * flood the broker with unbounded concurrent work.
 */
export class BrokerChannel {
  readonly socketPath: string;
  readonly #logger: Logger;
  readonly #handler: BrokerHandler | undefined;
  readonly #maxFrameBytes: number;
  readonly #maxConnections: number;
  readonly #maxPendingRequests: number;
  readonly #maxQueuedBytes: number;
  readonly #maxOutboundBytes: number;
  readonly #expectedPluginId: string | undefined;
  #listener: { stop(closeActiveConnections?: boolean): void } | undefined;
  readonly #connections = new WeakMap<BrokerSocket, Connection>();
  readonly #sockets = new Set<BrokerSocket>();
  #active: BrokerSocket | undefined;
  #nextCallId = 0;
  #invocationViewer: ViewerContext | undefined;
  #invocationQueue: Promise<unknown> = Promise.resolve();
  #hello:
    | {
        resolve(hello: PluginHello): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  constructor(options: BrokerChannelOptions) {
    this.socketPath = options.socketPath;
    this.#logger = options.logger;
    this.#handler = options.handler;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.#maxConnections = positiveInteger(
      options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
      "maxConnections",
    );
    this.#maxPendingRequests = positiveInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      "maxPendingRequests",
    );
    this.#maxQueuedBytes = positiveInteger(
      options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
      "maxQueuedBytes",
    );
    this.#maxOutboundBytes = positiveInteger(
      options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES,
      "maxOutboundBytes",
    );
    this.#expectedPluginId = options.expectedPluginId;
  }

  get listening(): boolean {
    return this.#listener !== undefined;
  }

  async start(): Promise<void> {
    if (this.#listener !== undefined) {
      return;
    }

    await mkdir(dirname(this.socketPath), { recursive: true });
    await unlink(this.socketPath).catch(() => undefined);

    this.#listener = Bun.listen({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          if (this.#sockets.size >= this.#maxConnections) {
            this.#logger.warn("broker.connection_rejected", {
              connections: this.#sockets.size,
            });
            socket.end();
            return;
          }

          this.#logger.debug("broker.client_connected");
          this.#sockets.add(socket);
          this.#connections.set(socket, {
            decoder: new FrameDecoder(this.#maxFrameBytes),
            pluginId: null,
            queue: Promise.resolve(),
            pending: 0,
            queuedBytes: 0,
            outbound: [],
            outboundOffset: 0,
            outboundBytes: 0,
            flushing: false,
            calls: new Map(),
          });
        },
        data: (socket, data) => {
          this.#onData(socket, data);
        },
        close: (socket) => {
          this.#sockets.delete(socket);
          const connection = this.#connections.get(socket);

          if (connection !== undefined) {
            connection.outbound.length = 0;
            connection.outboundBytes = 0;

            for (const call of connection.calls.values()) {
              clearTimeout(call.timer);
              call.reject(new Error("Plugin disconnected"));
            }

            connection.calls.clear();
            this.#connections.delete(socket);
          }

          if (this.#active === socket) {
            this.#active = undefined;
          }

          if (this.#hello !== undefined) {
            clearTimeout(this.#hello.timer);
            this.#hello.reject(new Error("Sandbox disconnected before the broker handshake"));
            this.#hello = undefined;
          }
        },
        drain: (socket) => {
          const connection = this.#connections.get(socket);

          if (connection !== undefined) {
            this.#flushOutbound(socket, connection);
          }
        },
        error: (_socket, error) => {
          this.#logger.warn("broker.client_error", { error });
        },
      },
    });

    // The plugin runs as a different UID inside its own user namespace. The socket is only
    // reachable through the bind mount, so world-connectable is the simplest safe option for
    // one sandbox; per-plugin sockets and broker tokens arrive with the broker work (task 2.2).
    await chmod(this.socketPath, 0o666);
    this.#logger.info("broker.listening", { socket: this.socketPath });
  }

  /** Resolves with the next handshake. Subscribe before spawning the sandbox to avoid races. */
  waitForHello(timeoutMs: number): Promise<PluginHello> {
    if (this.#hello !== undefined) {
      return Promise.reject(new Error("A broker handshake is already pending"));
    }

    return new Promise<PluginHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#hello = undefined;
        reject(new Error(`No broker handshake within ${timeoutMs} ms`));
      }, timeoutMs);

      this.#hello = { resolve, reject, timer };
    });
  }

  /** Drops a pending handshake, e.g. when nsjail exited before the plugin connected. */
  cancelHello(reason = "Broker handshake cancelled"): void {
    this.#fail(new Error(reason));
  }

  async close(): Promise<void> {
    if (this.#hello !== undefined) {
      clearTimeout(this.#hello.timer);
      this.#hello.reject(new Error("Broker channel closed"));
      this.#hello = undefined;
    }

    this.#listener?.stop(true);
    this.#listener = undefined;
    this.#sockets.clear();
    await unlink(this.socketPath).catch(() => undefined);
  }

  #onData(socket: BrokerSocket, data: Uint8Array): void {
    const connection = this.#connections.get(socket);

    if (connection === undefined) {
      return;
    }

    let frames: DecodedFrame[];

    try {
      frames = connection.decoder.push(data);
    } catch (error) {
      if (error instanceof FrameError) {
        this.#logger.warn("broker.frame_rejected", { code: error.code });
        this.#fail(new Error(error.message));
        socket.end();
        return;
      }

      this.#logger.error("broker.decode_failed", { error });
      socket.end();
      return;
    }

    for (const frame of frames) {
      if (frame.kind === "message" && isResponse(frame.value)) {
        this.#settle(connection, frame.value);
        continue;
      }

      if (frame.kind === "invalid_json") {
        this.#send(socket, connection, failure(null, JSON_RPC_ERRORS.parse, frame.message));
        continue;
      }

      const message = parseMessage(frame.value);

      if (message === undefined) {
        this.#send(
          socket,
          connection,
          failure(null, JSON_RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request"),
        );
        continue;
      }

      if (
        connection.pending >= this.#maxPendingRequests ||
        connection.queuedBytes + frame.bytes > this.#maxQueuedBytes
      ) {
        this.#rejectBusy(socket, connection, message);
        continue;
      }

      connection.pending += 1;
      connection.queuedBytes += frame.bytes;
      connection.queue = connection.queue
        .then(async () => {
          if (!this.#connections.has(socket)) {
            return;
          }

          await this.#dispatch(socket, connection, message);
        })
        .catch((error: unknown) => {
          this.#logger.error("broker.dispatch_failed", { error });
        })
        .finally(() => {
          connection.pending -= 1;
          connection.queuedBytes -= frame.bytes;
        });
    }
  }

  #rejectBusy(
    socket: BrokerSocket,
    connection: Connection,
    message: JsonRpcRequest | JsonRpcNotification,
  ): void {
    this.#logger.warn("broker.request_rejected", { reason: "busy" });

    if (isRequest(message)) {
      this.#send(
        socket,
        connection,
        failure(message.id, JSON_RPC_ERRORS.denied, "Broker is busy", { reason: "busy" }),
      );
    }
  }

  async #dispatch(
    socket: BrokerSocket,
    connection: Connection,
    message: JsonRpcRequest | JsonRpcNotification,
  ): Promise<void> {
    if (message.method === "hello") {
      this.#onHello(socket, connection, message.params, isRequest(message) ? message.id : null);
      return;
    }

    if (connection.pluginId === null) {
      if (isRequest(message)) {
        this.#send(
          socket,
          connection,
          failure(message.id, JSON_RPC_ERRORS.invalidRequest, "Send hello before any request"),
        );
      }
      return;
    }

    if (this.#handler === undefined) {
      if (isRequest(message)) {
        this.#send(
          socket,
          connection,
          failure(message.id, JSON_RPC_ERRORS.methodNotFound, `Unknown method: ${message.method}`),
        );
      }
      return;
    }

    try {
      const result = await this.#handler.handle({
        method: message.method,
        params: message.params,
        pluginId: connection.pluginId,
        ...(this.#invocationViewer === undefined ? {} : { viewer: this.#invocationViewer }),
      });

      if (isRequest(message)) {
        this.#send(socket, connection, success(message.id, result));
      }
    } catch (error) {
      const rpcError =
        error instanceof RpcError
          ? error
          : new RpcError(JSON_RPC_ERRORS.internal, "Broker request failed");

      if (!(error instanceof RpcError)) {
        this.#logger.error("broker.request_failed", { method: message.method, error });
      }

      if (isRequest(message)) {
        this.#send(
          socket,
          connection,
          failure(message.id, rpcError.code, rpcError.message, rpcError.data),
        );
      }
    }
  }

  #onHello(
    socket: BrokerSocket,
    connection: Connection,
    params: unknown,
    id: JsonRpcId | null,
  ): void {
    if (connection.pluginId !== null) {
      if (id !== null) {
        this.#send(
          socket,
          connection,
          failure(id, JSON_RPC_ERRORS.invalidRequest, "Hello already sent"),
        );
      }
      return;
    }

    const hello = parseHello(params);

    if (hello === undefined) {
      if (id !== null) {
        this.#send(socket, connection, failure(id, JSON_RPC_ERRORS.invalidParams, "Invalid hello"));
      }
      this.#fail(new Error("Sandbox sent an invalid broker handshake"));
      return;
    }

    if (
      (this.#expectedPluginId !== undefined && hello.pluginId !== this.#expectedPluginId) ||
      (this.#active !== undefined && this.#active !== socket) ||
      (this.#hello === undefined && connection.pluginId !== null)
    ) {
      this.#logger.warn("broker.identity_rejected", {
        announced: hello.pluginId,
        expected: this.#expectedPluginId,
      });
      if (id !== null) {
        this.#send(
          socket,
          connection,
          failure(id, JSON_RPC_ERRORS.denied, "Plugin identity is not accepted"),
        );
      }
      this.#fail(new Error("Sandbox announced an unexpected plugin identity"));
      socket.end();
      return;
    }

    connection.pluginId = hello.pluginId;
    this.#active = socket;

    if (id !== null) {
      this.#send(socket, connection, success(id, null));
    }

    if (this.#hello === undefined) {
      this.#logger.warn("broker.unexpected_hello", { pluginId: hello.pluginId });
      return;
    }

    const pending = this.#hello;
    this.#hello = undefined;
    clearTimeout(pending.timer);
    this.#logger.info("broker.hello", { pluginId: hello.pluginId });
    pending.resolve(hello);
  }

  /**
   * Sends a broker→plugin request (hook dispatch) and resolves with the plugin's reply.
   * One channel serves one plugin sandbox, so the most recently hello'd connection is the
   * target; a missing or closed connection fails the call and the caller applies its
   * hook failure policy.
   */
  /**
   * Sends a hook request with the trusted viewer context. Broker calls the plugin makes while
   * handling it (core.*) see that viewer; requests are serialized so contexts cannot mix.
   */
  requestWithContext<T = unknown>(
    method: string,
    params: unknown,
    viewer: ViewerContext,
    timeoutMs = 1_000,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      this.#invocationViewer = viewer;

      try {
        return await this.request<T>(method, params, timeoutMs);
      } finally {
        this.#invocationViewer = undefined;
      }
    };
    const result = this.#invocationQueue.then(run, run);
    this.#invocationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 1_000): Promise<T> {
    const socket = this.#active;
    const connection = socket === undefined ? undefined : this.#connections.get(socket);

    if (socket === undefined || connection === undefined || connection.pluginId === null) {
      return Promise.reject(new Error("No plugin is connected to the broker"));
    }

    const id = `broker-${String(++this.#nextCallId)}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.calls.delete(id);
        reject(new Error(`Plugin call ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();

      connection.calls.set(id, {
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      this.#send(socket, connection, { jsonrpc: "2.0", id, method, params });
    });
  }

  #settle(connection: Connection, response: JsonRpcResponse): void {
    if (response.id === null) {
      return;
    }

    const call = connection.calls.get(response.id);

    if (call === undefined) {
      return;
    }

    connection.calls.delete(response.id);
    clearTimeout(call.timer);

    if (response.error !== undefined) {
      call.reject(new RpcError(response.error.code, response.error.message, response.error.data));
      return;
    }

    call.resolve(response.result);
  }

  #send(socket: BrokerSocket, connection: Connection, message: unknown): void {
    let frame: Uint8Array;

    try {
      frame = encodeFrame(message, this.#maxFrameBytes);
    } catch (error) {
      this.#logger.error("broker.write_failed", { error });
      socket.end();
      return;
    }

    if (connection.outboundBytes + frame.byteLength > this.#maxOutboundBytes) {
      this.#logger.warn("broker.output_overflow", {
        bytes: connection.outboundBytes + frame.byteLength,
      });
      socket.end();
      return;
    }

    connection.outbound.push(frame);
    connection.outboundBytes += frame.byteLength;
    this.#flushOutbound(socket, connection);
  }

  #flushOutbound(socket: BrokerSocket, connection: Connection): void {
    if (connection.flushing) {
      return;
    }

    connection.flushing = true;

    try {
      while (connection.outbound.length > 0) {
        const head = connection.outbound[0];

        if (head === undefined) {
          break;
        }

        const written = socket.write(head.subarray(connection.outboundOffset));

        if (written < 0) {
          this.#logger.error("broker.write_failed", { bytes: head.byteLength });
          socket.end();
          return;
        }

        if (written === 0) {
          break;
        }

        connection.outboundBytes -= written;
        connection.outboundOffset += written;

        if (connection.outboundOffset < head.byteLength) {
          break;
        }

        connection.outbound.shift();
        connection.outboundOffset = 0;
      }
    } catch (error) {
      this.#logger.error("broker.write_failed", { error });
      socket.end();
    } finally {
      connection.flushing = false;
    }
  }

  #fail(error: Error): void {
    if (this.#hello === undefined) {
      return;
    }

    const pending = this.#hello;
    this.#hello = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}
