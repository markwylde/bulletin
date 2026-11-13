/** Length-prefixed JSON-RPC 2.0 transport used between a plugin and the broker. */

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Broker policy denial (statement allowlist, egress rules). */
  denied: -32000,
} as const;

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export function success(id: JsonRpcId | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function failure(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accepts a request (with an id) or a notification (without one). `null` is not a valid
 * request id; JSON-RPC uses it only for unidentifiable errors.
 */
export function parseMessage(value: unknown): JsonRpcRequest | JsonRpcNotification | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return undefined;
  }

  if (typeof value.method !== "string" || value.method.length === 0) {
    return undefined;
  }

  if (value.method.length > 128) {
    return undefined;
  }

  const params = value.params ?? null;

  if ("id" in value) {
    if (typeof value.id !== "string" && typeof value.id !== "number") {
      return undefined;
    }

    return { jsonrpc: "2.0", id: value.id, method: value.method, params };
  }

  return { jsonrpc: "2.0", method: value.method, params };
}

export function isRequest(
  message: JsonRpcRequest | JsonRpcNotification,
): message is JsonRpcRequest {
  return "id" in message;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Encodes one frame: 4-byte big-endian length followed by UTF-8 JSON. */
export function encodeFrame(value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  const json = JSON.stringify(value, jsonReplacer);
  const payload = new TextEncoder().encode(json ?? "null");

  if (payload.byteLength > maxFrameBytes) {
    throw new FrameError("too_large", `Frame exceeds ${maxFrameBytes} bytes`);
  }

  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

export type FrameErrorCode = "too_large" | "empty";

export class FrameError extends Error {
  readonly code: FrameErrorCode;

  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export type DecodedFrame =
  | { readonly kind: "message"; readonly value: unknown; readonly bytes: number }
  | { readonly kind: "invalid_json"; readonly message: string };

/**
 * Incremental decoder. A malformed JSON payload does not break framing (the length is
 * known), so it is reported as a result and the next frame can still be read. A bad length
 * is fatal for the connection.
 */
export class FrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = new Uint8Array(0);
  #expected: number | null = null;

  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Uint8Array): DecodedFrame[] {
    this.#append(chunk);
    const frames: DecodedFrame[] = [];

    while (true) {
      if (this.#expected === null) {
        if (this.#buffer.byteLength < 4) {
          break;
        }

        const length = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(
          0,
          false,
        );

        if (length === 0) {
          throw new FrameError("empty", "Broker frame has no payload");
        }

        if (length > this.#maxFrameBytes) {
          throw new FrameError("too_large", `Broker frame exceeds ${this.#maxFrameBytes} bytes`);
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

      try {
        frames.push({
          kind: "message",
          value: JSON.parse(new TextDecoder().decode(payload)),
          bytes: payload.byteLength,
        });
      } catch {
        frames.push({ kind: "invalid_json", message: "Broker frame is not valid JSON" });
      }
    }

    return frames;
  }

  #append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) {
      return;
    }

    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer, 0);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;
  }
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Broker→plugin replies carry an id and exactly one of result/error, never a method. */
export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !("id" in value) || "method" in value) {
    return false;
  }

  return value.id === null || typeof value.id === "string" || typeof value.id === "number";
}
