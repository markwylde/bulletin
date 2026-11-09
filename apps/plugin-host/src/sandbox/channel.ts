import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@bulletin/config";

/** First message a plugin sends over the broker socket. */
export interface PluginHello {
  readonly type: "hello";
  readonly pluginId: string;
  readonly sdkVersion: string;
}

export interface BrokerChannelOptions {
  readonly socketPath: string;
  readonly logger: Logger;
  /** Guards the line buffer; a plugin must not be able to grow it without bound. */
  readonly maxLineBytes?: number;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

function parseHello(line: string): PluginHello | undefined {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    record.type !== "hello" ||
    typeof record.pluginId !== "string" ||
    record.pluginId === "" ||
    typeof record.sdkVersion !== "string"
  ) {
    return undefined;
  }

  return { type: "hello", pluginId: record.pluginId, sdkVersion: record.sdkVersion };
}

/**
 * The broker's Unix-socket listener. For the spike it only handles the plugin handshake that
 * proves the sandbox's single channel works; the JSON-RPC dispatch is added by
 * `plugin-platform`.
 */
export class BrokerChannel {
  readonly socketPath: string;
  readonly #logger: Logger;
  readonly #maxLineBytes: number;
  #listener: { stop(closeActiveConnections?: boolean): void } | undefined;
  readonly #buffers = new WeakMap<object, { readonly decoder: TextDecoder; text: string }>();
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
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
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
          this.#buffers.set(socket, { decoder: new TextDecoder(), text: "" });
        },
        data: (socket, data) => {
          this.#onData(socket, data);
        },
        close: (socket) => {
          this.#buffers.delete(socket);

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

  #onData(socket: object, data: Uint8Array): void {
    const state = this.#buffers.get(socket) ?? { decoder: new TextDecoder(), text: "" };
    const next = state.text + state.decoder.decode(data, { stream: true });
    const newline = next.indexOf("\n");

    if (newline === -1) {
      if (next.length > this.#maxLineBytes) {
        this.#logger.warn("broker.line_too_long", { bytes: next.length });
        this.#buffers.delete(socket);
        this.#fail(new Error("Sandbox sent an oversized broker message"));
      } else {
        state.text = next;
        this.#buffers.set(socket, state);
      }

      return;
    }

    const line = next.slice(0, newline);
    state.text = next.slice(newline + 1);
    this.#buffers.set(socket, state);

    const hello = parseHello(line);

    if (hello === undefined) {
      this.#logger.warn("broker.invalid_message", { bytes: line.length });
      this.#fail(new Error("Sandbox sent an invalid broker message"));
      return;
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
