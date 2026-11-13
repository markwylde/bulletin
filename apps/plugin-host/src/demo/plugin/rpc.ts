import { AsyncLocalStorage } from "node:async_hooks";
import { encodeFrame, FrameDecoder } from "./framing.ts";

/** Minimal JSON-RPC client for the broker socket used by the demo plugin. */
export class BrokerCallError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "BrokerCallError";
    this.code = code;
  }
}

export type BrokerRequestHandler = (request: {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
  readonly invocation?: string;
}) => Promise<unknown>;

export interface BrokerClient {
  call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  onRequest(handler: BrokerRequestHandler): void;
  close(): void;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CALL_TIMEOUT_MS = 5_000;
const MAX_OUTBOUND_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function connectBroker(
  socketPath: string,
  hello: { readonly pluginId: string; readonly sdkVersion: string },
): Promise<BrokerClient> {
  const decoder = new FrameDecoder();
  const pending = new Map<number, PendingCall>();
  const outbound: Uint8Array[] = [];
  let outboundOffset = 0;
  let outboundBytes = 0;
  let flushing = false;
  let nextId = 1;
  let socket: Bun.Socket | undefined;
  let requestHandler: BrokerRequestHandler | undefined;
  const invocation = new AsyncLocalStorage<string | undefined>();

  const flushOutbound = (): void => {
    if (socket === undefined || flushing) {
      return;
    }

    flushing = true;

    try {
      while (outbound.length > 0) {
        const head = outbound[0];

        if (head === undefined) {
          break;
        }

        const written = socket.write(head.subarray(outboundOffset));

        if (written <= 0) {
          break;
        }

        outboundBytes -= written;
        outboundOffset += written;

        if (outboundOffset < head.byteLength) {
          break;
        }

        outbound.shift();
        outboundOffset = 0;
      }
    } finally {
      flushing = false;
    }
  };

  const send = (value: unknown): void => {
    const frame = encodeFrame(value);

    if (outboundBytes + frame.byteLength > MAX_OUTBOUND_BYTES) {
      throw new Error("Broker client output queue is full");
    }

    outbound.push(frame);
    outboundBytes += frame.byteLength;
    flushOutbound();
  };

  const rejectAll = (error: Error): void => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };

  socket = await Bun.connect({
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
          if (!isRecord(value)) {
            continue;
          }

          if (
            typeof value.method === "string" &&
            (typeof value.id === "number" || typeof value.id === "string")
          ) {
            const id = value.id;
            const token = typeof value.invocation === "string" ? value.invocation : undefined;
            void (async () => {
              try {
                const result =
                  requestHandler === undefined
                    ? null
                    : await invocation.run(token, () =>
                        requestHandler?.({
                          id,
                          method: value.method as string,
                          params: value.params,
                          ...(token === undefined ? {} : { invocation: token }),
                        }),
                      );
                send({ jsonrpc: "2.0", id, result: result ?? null });
              } catch (error) {
                send({
                  jsonrpc: "2.0",
                  id,
                  error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : String(error),
                  },
                });
              }
            })();
            continue;
          }

          if (typeof value.id !== "number") {
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
      drain() {
        flushOutbound();
      },
      close() {
        outbound.length = 0;
        outboundBytes = 0;
        rejectAll(new Error("Broker socket closed"));
      },
      error(_socket, error) {
        rejectAll(error);
      },
    },
  });

  try {
    send({
      jsonrpc: "2.0",
      method: "hello",
      params: { pluginId: hello.pluginId, sdkVersion: hello.sdkVersion },
    });
  } catch (error) {
    socket.end();
    throw error;
  }

  return {
    onRequest(handler) {
      requestHandler = handler;
    },
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

        try {
          const token = invocation.getStore();
          send({
            jsonrpc: "2.0",
            id,
            method,
            params,
            ...(token === undefined ? {} : { invocation: token }),
          });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close() {
      outbound.length = 0;
      outboundBytes = 0;
      rejectAll(new Error("Broker client closed"));
      socket?.end();
    },
  };
}
