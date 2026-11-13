/** Length-prefixed JSON-RPC framing shared by the plugin SDK and plugin-host. */

export const MAX_FRAME_BYTES = 1024 * 1024;

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
  /** Dispatch token the broker issued for the request being handled. */
  readonly invocation?: string;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
  readonly invocation?: string;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export class FrameDecoder {
  #buffer = new Uint8Array(0);
  #expected: number | null = null;

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength > 0) {
      const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
      next.set(this.#buffer, 0);
      next.set(chunk, this.#buffer.byteLength);
      this.#buffer = next;
    }

    const messages: unknown[] = [];

    while (true) {
      if (this.#expected === null) {
        if (this.#buffer.byteLength < 4) {
          break;
        }

        const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(
          0,
          false,
        );

        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new Error("Invalid broker frame length");
        }

        this.#expected = length;
        this.#buffer = this.#buffer.subarray(4);
      }

      if (this.#buffer.byteLength < this.#expected) {
        break;
      }

      const payload = this.#buffer.subarray(0, this.#expected);
      this.#buffer = this.#buffer.subarray(this.#expected);
      this.#expected = null;
      messages.push(JSON.parse(new TextDecoder().decode(payload)) as unknown);
    }

    return messages;
  }
}

export function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof (value as { id?: unknown }).id !== "undefined" &&
    !("method" in value)
  );
}

export function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof (value as { method?: unknown }).method === "string" &&
    "id" in value
  );
}
