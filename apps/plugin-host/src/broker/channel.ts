import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bulletin/config";
import {
  DEFAULT_MAX_FRAME_BYTES,
  type DecodedFrame,
  encodeFrame,
  FrameDecoder,
  FrameError,
  failure,
  isRequest,
  JSON_RPC_ERRORS,
  type JsonRpcId,
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
  }): Promise<unknown>;
}

export interface BrokerChannelOptions {
  readonly socketPath: string;
  readonly logger: Logger;
  readonly handler?: BrokerHandler;
  /** Caps one plugin message and one broker response. */
  readonly maxFrameBytes?: number;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;

interface BrokerSocket {
  write(data: Uint8Array): void;
  end(): void;
}

interface Connection {
  readonly decoder: FrameDecoder;
  pluginId: string | null;
  queue: Promise<void>;
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
  #listener: { stop(closeActiveConnections?: boolean): void } | undefined;
  readonly #connections = new WeakMap<BrokerSocket, Connection>();
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
          this.#logger.debug("broker.client_connected");
          this.#connections.set(socket, {
            decoder: new FrameDecoder(this.#maxFrameBytes),
            pluginId: null,
            queue: Promise.resolve(),
          });
        },
        data: (socket, data) => {
          this.#onData(socket, data);
        },
        close: (socket) => {
          this.#connections.delete(socket);

          if (this.#hello !== undefined) {
            clearTimeout(this.#hello.timer);
            this.#hello.reject(new Error("Sandbox disconnected before the broker handshake"));
            this.#hello = undefined;
          }
        },
        error: (_socket, error) => {
          this.#logger.warn("broker.client_error", { error });
        },
      },
    });

    // The plugin runs as a different UID inside its own user namespace. The socket is only
    // reachable through the bind mount, so world-connectable is the spike's simplest safe
    // option; per-plugin sockets and broker tokens arrive with `plugin-platform`.
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
      if (frame.kind === "invalid_json") {
        this.#send(socket, failure(null, JSON_RPC_ERRORS.parse, frame.message));
        continue;
      }

      connection.queue = connection.queue
        .then(() => this.#dispatch(socket, connection, frame.value))
        .catch((error: unknown) => {
          this.#logger.error("broker.dispatch_failed", { error });
        });
    }
  }

  async #dispatch(socket: BrokerSocket, connection: Connection, value: unknown): Promise<void> {
    const message = parseMessage(value);

    if (message === undefined) {
      this.#send(socket, failure(null, JSON_RPC_ERRORS.invalidRequest, "Invalid JSON-RPC request"));
      return;
    }

    if (message.method === "hello") {
      this.#onHello(socket, connection, message.params, isRequest(message) ? message.id : null);
      return;
    }

    if (connection.pluginId === null) {
      if (isRequest(message)) {
        this.#send(
          socket,
          failure(message.id, JSON_RPC_ERRORS.invalidRequest, "Send hello before any request"),
        );
      }
      return;
    }

    if (this.#handler === undefined) {
      if (isRequest(message)) {
        this.#send(
          socket,
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
      });

      if (isRequest(message)) {
        this.#send(socket, success(message.id, result));
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
        this.#send(socket, failure(message.id, rpcError.code, rpcError.message, rpcError.data));
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
        this.#send(socket, failure(id, JSON_RPC_ERRORS.invalidRequest, "Hello already sent"));
      }
      return;
    }

    const hello = parseHello(params);

    if (hello === undefined) {
      if (id !== null) {
        this.#send(socket, failure(id, JSON_RPC_ERRORS.invalidParams, "Invalid hello"));
      }
      this.#fail(new Error("Sandbox sent an invalid broker handshake"));
      return;
    }

    connection.pluginId = hello.pluginId;

    if (id !== null) {
      this.#send(socket, success(id, null));
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

  #send(socket: BrokerSocket, message: unknown): void {
    try {
      socket.write(encodeFrame(message, this.#maxFrameBytes));
    } catch (error) {
      this.#logger.error("broker.write_failed", { error });
      socket.end();
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
