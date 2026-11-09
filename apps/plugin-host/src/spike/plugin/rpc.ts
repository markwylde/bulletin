import { encodeFrame, FrameDecoder } from "./framing.ts";

/** Minimal JSON-RPC client for the broker socket used by the spike plugin. */
export class BrokerCallError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "BrokerCallError";
    this.code = code;
  }
}

export interface BrokerClient {
  call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  close(): void;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CALL_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function connectBroker(
  socketPath: string,
  hello: { readonly pluginId: string; readonly sdkVersion: string },
): Promise<BrokerClient> {
  const decoder = new FrameDecoder();
  const pending = new Map<number, PendingCall>();
  let nextId = 1;

  const rejectAll = (error: Error): void => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };

  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, data) {
        let values: unknown[];

        try {
          values = decoder.push(data);
        } catch (error) {
          rejectAll(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        for (const value of values) {
          if (!isRecord(value) || typeof value.id !== "number") {
            continue;
          }

          const call = pending.get(value.id);

          if (call === undefined) {
            continue;
          }

          pending.delete(value.id);
          clearTimeout(call.timer);

          if (isRecord(value.error)) {
            call.reject(
              new BrokerCallError(
                typeof value.error.code === "number" ? value.error.code : -32603,
                typeof value.error.message === "string"
                  ? value.error.message
                  : "Broker request failed",
              ),
            );
          } else {
            call.resolve(value.result);
          }
        }
      },
      close() {
        rejectAll(new Error("Broker socket closed"));
      },
      error(_socket, error) {
        rejectAll(error);
      },
    },
  });

  socket.write(
    encodeFrame({
      jsonrpc: "2.0",
      method: "hello",
      params: { pluginId: hello.pluginId, sdkVersion: hello.sdkVersion },
    }),
  );

  return {
    call<T>(method: string, params: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<T> {
      const id = nextId;
      nextId += 1;

      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Broker call ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });

        socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
      });
    },
    close() {
      rejectAll(new Error("Broker client closed"));
      socket.end();
    },
  };
}
