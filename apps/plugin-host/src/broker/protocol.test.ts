import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  failure,
  isRequest,
  parseMessage,
  RpcError,
  success,
} from "./protocol.ts";

function decodeAll(chunks: readonly Uint8Array[]): unknown[] {
  const decoder = new FrameDecoder();
  const values: unknown[] = [];

  for (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) {
      if (frame.kind === "message") {
        values.push(frame.value);
      }
    }
  }

  return values;
}

describe("length-prefixed JSON-RPC framing", () => {
  test("round-trips a frame and encodes bigint values as strings", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, result: { id: 9007199254740993n } });
    const decoder = new FrameDecoder();
    const [decoded] = decoder.push(frame);

    expect(decoded).toEqual({
      kind: "message",
      value: { jsonrpc: "2.0", id: 1, result: { id: "9007199254740993" } },
    });
  });

  test("decodes frames split at every byte boundary", () => {
    const frame = encodeFrame({ hello: "world" });

    for (let split = 1; split < frame.byteLength; split += 1) {
      expect(decodeAll([frame.subarray(0, split), frame.subarray(split)])).toEqual([
        { hello: "world" },
      ]);
    }
  });

  test("decodes several frames from one chunk", () => {
    const first = encodeFrame({ n: 1 });
    const second = encodeFrame({ n: 2 });
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);

    expect(decodeAll([combined])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("rejects an empty frame", () => {
    const frame = new Uint8Array(4);
    expect(() => new FrameDecoder().push(frame)).toThrow(FrameError);
  });

  test("rejects a frame larger than the configured cap", () => {
    const frame = new Uint8Array(4);
    new DataView(frame.buffer).setUint32(0, 1024 * 1024 + 1, false);

    expect(() => new FrameDecoder().push(frame)).toThrow("exceeds");
  });

  test("reports invalid JSON without losing the next frame", () => {
    const payload = new TextEncoder().encode("not json");
    const invalid = new Uint8Array(4 + payload.byteLength);
    new DataView(invalid.buffer).setUint32(0, payload.byteLength, false);
    invalid.set(payload, 4);

    const decoder = new FrameDecoder();
    expect(decoder.push(invalid)[0]).toEqual({
      kind: "invalid_json",
      message: "Broker frame is not valid JSON",
    });
    expect(decoder.push(encodeFrame({ ok: true }))[0]).toEqual({
      kind: "message",
      value: { ok: true },
    });
  });

  test("refuses responses larger than the cap", () => {
    expect(() => encodeFrame({ text: "x".repeat(2048) }, 1024)).toThrow("exceeds");
  });
});

describe("JSON-RPC messages", () => {
  test("parses requests and notifications", () => {
    const request = parseMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "db.query",
      params: { sql: "SELECT 1" },
    });
    const notification = parseMessage({
      jsonrpc: "2.0",
      method: "hello",
      params: { pluginId: "sandbox-demo", sdkVersion: "0.0.0" },
    });

    expect(request).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "db.query",
      params: { sql: "SELECT 1" },
    });
    expect(request === undefined || !isRequest(request)).toBe(false);
    expect(notification).toEqual({
      jsonrpc: "2.0",
      method: "hello",
      params: { pluginId: "sandbox-demo", sdkVersion: "0.0.0" },
    });
    expect(notification === undefined || isRequest(notification)).toBe(false);
  });

  test("rejects malformed requests", () => {
    expect(parseMessage({ jsonrpc: "1.0", id: 1, method: "x" })).toBeUndefined();
    expect(parseMessage({ jsonrpc: "2.0", id: null, method: "x" })).toBeUndefined();
    expect(parseMessage({ jsonrpc: "2.0", id: 1 })).toBeUndefined();
    expect(parseMessage({ jsonrpc: "2.0", id: 1, method: "" })).toBeUndefined();
    expect(parseMessage([])).toBeUndefined();
  });

  test("builds success and failure responses", () => {
    expect(success(3, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { ok: true },
    });
    expect(failure(null, -32700, "bad")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "bad" },
    });
  });

  test("carries a code and optional data on RpcError", () => {
    const error = new RpcError(-32000, "denied", { reason: "schema" });

    expect(error.code).toBe(-32000);
    expect(error.data).toEqual({ reason: "schema" });
  });
});
