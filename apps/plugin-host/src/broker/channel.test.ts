import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@bulletin/config";
import { BrokerChannel, type BrokerChannelOptions, type BrokerHandler } from "./channel.ts";
import { encodeFrame, FrameDecoder, RpcError } from "./protocol.ts";

const logger = createLogger({ service: "broker-test", level: "error", sink: () => {} });
const channels: BrokerChannel[] = [];
const directories: string[] = [];

async function createChannel(
  handler?: BrokerHandler,
  options: Pick<
    BrokerChannelOptions,
    "maxConnections" | "maxPendingRequests" | "maxQueuedBytes" | "maxOutboundBytes"
  > = {},
): Promise<BrokerChannel> {
  const directory = await mkdtemp(join(tmpdir(), "bulletin-broker-"));
  directories.push(directory);
  const channel = new BrokerChannel({
    socketPath: join(directory, "broker.sock"),
    logger,
    ...(handler === undefined ? {} : { handler }),
    ...options,
  });
  await channel.start();
  channels.push(channel);
  return channel;
}

interface Client {
  readonly socket: { write(data: Uint8Array): void; end(): void };
  readonly closed: Promise<void>;
  write(value: unknown): void;
  writeRaw(frame: Uint8Array): void;
  next(): Promise<unknown>;
  pause(): void;
  resume(): void;
}

async function connect(socketPath: string): Promise<Client> {
  const decoder = new FrameDecoder();
  const messages: unknown[] = [];
  let closeSocket: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    closeSocket = resolve;
  });
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_socket, data) {
        for (const frame of decoder.push(data)) {
          if (frame.kind === "message") {
            messages.push(frame.value);
          }
        }
      },
      close() {
        closeSocket();
      },
      error() {},
    },
  });

  return {
    socket,
    closed,
    write(value) {
      socket.write(encodeFrame(value));
    },
    writeRaw(frame) {
      socket.write(frame);
    },
    pause() {
      socket.pause();
    },
    resume() {
      socket.resume();
    },
    async next() {
      const deadline = Date.now() + 2_000;

      while (messages.length === 0) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for a broker response");
        }

        await Bun.sleep(2);
      }

      return messages.shift();
    },
  };
}

function helloNotification(): unknown {
  return {
    jsonrpc: "2.0",
    method: "hello",
    params: { pluginId: "sandbox-demo", sdkVersion: "0.0.0" },
  };
}

function rawFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    await channel.close();
  }

  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("broker channel", () => {
  test("binds core calls made during a hook to the trusted viewer", async () => {
    const seen: Array<unknown> = [];
    const channel = await createChannel({
      async handle(request) {
        seen.push(request.viewer);
        return null;
      },
    });
    const client = await connect(channel.socketPath);
    client.write(helloNotification());
    await channel.waitForHello(500);

    const hook = channel.requestWithContext("hook.enrich", {}, { memberId: "7" }, 500);
    const request = (await client.next()) as { id: unknown };
    client.write({ jsonrpc: "2.0", id: 2, method: "db.query", params: { sql: "SELECT 1" } });
    await client.next();
    client.write({ jsonrpc: "2.0", id: request.id, result: {} });
    await hook;

    expect(seen).toEqual([{ memberId: "7" }]);
    client.socket.end();
  });

  test("rejects a sandbox that announces a different plugin identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bulletin-broker-"));
    directories.push(directory);
    const channel = new BrokerChannel({
      socketPath: join(directory, "broker.sock"),
      logger,
      expectedPluginId: "sandbox-demo",
    });
    await channel.start();
    channels.push(channel);

    const client = await connect(channel.socketPath);
    client.write({
      jsonrpc: "2.0",
      method: "hello",
      params: { pluginId: "other", sdkVersion: "2" },
    });
    await Bun.sleep(50);
    await expect(channel.request("hook.enrich", {})).rejects.toThrow("No plugin is connected");
    client.socket.end();
  });

  test("sends a broker-to-plugin request and resolves with the reply", async () => {
    const channel = await createChannel();
    const client = await connect(channel.socketPath);
    client.write(helloNotification());
    await channel.waitForHello(500);

    const call = channel.request<{ fields: Record<string, unknown> }>("hook.enrich", {
      hook: "post.view",
    });
    const request = (await client.next()) as { id: unknown; method: string; params: unknown };
    expect(request).toMatchObject({ method: "hook.enrich", params: { hook: "post.view" } });
    client.write({ jsonrpc: "2.0", id: request.id, result: { fields: { tip: 5 } } });

    await expect(call).resolves.toEqual({ fields: { tip: 5 } });
    client.socket.end();
  });

  test("rejects a broker-to-plugin request when no plugin is connected", async () => {
    const channel = await createChannel();
    await expect(channel.request("hook.enrich", {})).rejects.toThrow("No plugin is connected");
  });

  test("rejects a broker-to-plugin request on its deadline", async () => {
    const channel = await createChannel();
    const client = await connect(channel.socketPath);
    client.write(helloNotification());
    await channel.waitForHello(500);

    await expect(channel.request("hook.enrich", {}, 20)).rejects.toThrow("timed out");
    client.socket.end();
  });

  test("propagates a plugin error response", async () => {
    const channel = await createChannel();
    const client = await connect(channel.socketPath);
    client.write(helloNotification());
    await channel.waitForHello(500);

    const call = channel.request("hook.enrich", {});
    const request = (await client.next()) as { id: unknown };
    client.write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: "boom" },
    });

    await expect(call).rejects.toBeInstanceOf(RpcError);
    client.socket.end();
  });

  test("resolves the supervisor on a hello notification", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());

    await expect(hello).resolves.toEqual({
      pluginId: "sandbox-demo",
      sdkVersion: "0.0.0",
    });
    client.socket.end();
  });

  test("dispatches requests with the connection's plugin id", async () => {
    const calls: Array<{ method: string; pluginId: string }> = [];
    const handler: BrokerHandler = {
      async handle(request) {
        calls.push({ method: request.method, pluginId: request.pluginId });
        return { rows: [{ id: "1" }] };
      },
    };
    const channel = await createChannel(handler);
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;
    client.write({
      jsonrpc: "2.0",
      id: 1,
      method: "db.query",
      params: { sql: "SELECT 1" },
    });

    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { rows: [{ id: "1" }] },
    });
    expect(calls).toEqual([{ method: "db.query", pluginId: "sandbox-demo" }]);
    client.socket.end();
  });

  test("handles hello and a request arriving in one chunk", async () => {
    const channel = await createChannel({
      async handle() {
        return null;
      },
    });
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);
    const first = encodeFrame(helloNotification());
    const second = encodeFrame({ jsonrpc: "2.0", id: 9, method: "log", params: {} });
    const combined = new Uint8Array(first.byteLength + second.byteLength);
    combined.set(first);
    combined.set(second, first.byteLength);

    client.writeRaw(combined);

    await hello;
    expect(await client.next()).toEqual({ jsonrpc: "2.0", id: 9, result: null });
    client.socket.end();
  });

  test("refuses requests before hello", async () => {
    let called = false;
    const channel = await createChannel({
      async handle() {
        called = true;
        return null;
      },
    });
    const client = await connect(channel.socketPath);

    client.write({ jsonrpc: "2.0", id: 4, method: "db.query", params: {} });

    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32600, message: "Send hello before any request" },
    });
    expect(called).toBe(false);
    client.socket.end();
  });

  test("reports method-not-found without a handler", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;
    client.write({ jsonrpc: "2.0", id: 5, method: "db.query", params: {} });

    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: { code: -32601, message: "Unknown method: db.query" },
    });
    client.socket.end();
  });

  test("maps broker denials and unexpected errors to JSON-RPC errors", async () => {
    let mode: "denied" | "crash" = "denied";
    const channel = await createChannel({
      async handle() {
        if (mode === "denied") {
          throw new RpcError(-32000, "Statement denied", { kind: "sql" });
        }

        throw new Error("database exploded");
      },
    });
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;
    client.write({ jsonrpc: "2.0", id: 1, method: "db.query", params: {} });

    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Statement denied", data: { kind: "sql" } },
    });

    mode = "crash";
    client.write({ jsonrpc: "2.0", id: 2, method: "db.query", params: {} });

    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32603, message: "Broker request failed" },
    });
    client.socket.end();
  });

  test("does not reply to notifications", async () => {
    let called = 0;
    const channel = await createChannel({
      async handle() {
        called += 1;
        return "ignored";
      },
    });
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;
    client.write({ jsonrpc: "2.0", method: "log", params: { level: "info" } });
    await Bun.sleep(20);

    expect(called).toBe(1);
    client.socket.end();
  });

  test("assembles a fragmented frame", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);
    const frame = encodeFrame(helloNotification());

    client.writeRaw(frame.subarray(0, 2));
    await Bun.sleep(5);
    client.writeRaw(frame.subarray(2));

    await expect(hello).resolves.toMatchObject({ pluginId: "sandbox-demo" });
    client.socket.end();
  });

  test("reports invalid JSON and still accepts the next frame", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.writeRaw(rawFrame("not json"));
    client.write(helloNotification());

    expect(await client.next()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Broker frame is not valid JSON" },
    });
    await expect(hello).resolves.toMatchObject({ pluginId: "sandbox-demo" });
    client.socket.end();
  });

  test("drops the connection and the handshake when a frame is too large", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);
    const frame = new Uint8Array(4);
    new DataView(frame.buffer).setUint32(0, 1024 * 1024 + 1, false);

    client.writeRaw(frame);

    await expect(hello).rejects.toThrow("exceeds");
    client.socket.end();
  });

  test("cancels a pending handshake", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);

    channel.cancelHello("sandbox stopped");

    await expect(hello).rejects.toThrow("sandbox stopped");
  });

  test("allows only one pending handshake", async () => {
    const channel = await createChannel();
    const first = channel.waitForHello(2_000);

    await expect(channel.waitForHello(2_000)).rejects.toThrow("already pending");

    channel.cancelHello();
    await first.catch(() => undefined);
  });

  test("bounds queued requests while the handler is blocked", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const handler: BrokerHandler = {
      async handle() {
        calls += 1;
        await gate;
        return null;
      },
    };
    const channel = await createChannel(handler, { maxPendingRequests: 2 });
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;

    for (let id = 1; id <= 4; id += 1) {
      client.write({ jsonrpc: "2.0", id, method: "log", params: { level: "info" } });
    }

    const busy = [await client.next(), await client.next()] as Array<{
      id: number;
      error: { code: number; message: string };
    }>;
    expect(busy.map((message) => message.id).sort()).toEqual([3, 4]);

    for (const message of busy) {
      expect(message.error).toMatchObject({ code: -32000, message: "Broker is busy" });
    }

    release();

    const accepted = [await client.next(), await client.next()] as Array<{
      id: number;
      result: null;
    }>;
    expect(accepted.map((message) => message.id).sort()).toEqual([1, 2]);

    for (const message of accepted) {
      expect(message.result).toBeNull();
    }

    expect(calls).toBe(2);
    client.socket.end();
  });

  test("rejects a message larger than the queued byte budget", async () => {
    let calls = 0;
    const channel = await createChannel(
      {
        async handle() {
          calls += 1;
          return null;
        },
      },
      { maxQueuedBytes: 256 },
    );
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;
    client.write({
      jsonrpc: "2.0",
      id: 7,
      method: "log",
      params: { level: "info", message: "x".repeat(400) },
    });

    expect(await client.next()).toMatchObject({
      id: 7,
      error: { code: -32000, message: "Broker is busy" },
    });
    expect(calls).toBe(0);
    client.socket.end();
  });

  test("resumes a partially written large response before the next frame", async () => {
    const body = "x".repeat(700_000);
    const channel = await createChannel({
      async handle() {
        return { body };
      },
    });
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;

    client.pause();
    client.write({ jsonrpc: "2.0", id: 1, method: "log", params: { level: "info" } });
    await Bun.sleep(100);
    client.resume();

    const first = (await client.next()) as { id: number; result: { body: string } };
    expect(first.id).toBe(1);
    expect(first.result.body).toBe(body);

    client.write({ jsonrpc: "2.0", id: 2, method: "log", params: { level: "info" } });
    const second = (await client.next()) as { id: number; result: { body: string } };
    expect(second.id).toBe(2);
    expect(second.result.body).toBe(body);
    client.socket.end();
  }, 10_000);

  test("closes a connection when a slow reader exceeds the output queue", async () => {
    const channel = await createChannel(
      {
        async handle() {
          return { body: "x".repeat(700_000) };
        },
      },
      { maxOutboundBytes: 128 * 1024 },
    );
    const hello = channel.waitForHello(2_000);
    const client = await connect(channel.socketPath);

    client.write(helloNotification());
    await hello;
    client.write({ jsonrpc: "2.0", id: 3, method: "log", params: { level: "info" } });

    await Promise.race([
      client.closed,
      Bun.sleep(1_000).then(() => {
        throw new Error("slow reader was not disconnected");
      }),
    ]);
  }, 10_000);

  test("rejects connections above the limit", async () => {
    let calls = 0;
    const channel = await createChannel(
      {
        async handle() {
          calls += 1;
          return null;
        },
      },
      { maxConnections: 1 },
    );
    const hello = channel.waitForHello(2_000);
    const first = await connect(channel.socketPath);

    first.write(helloNotification());
    await hello;

    const second = await connect(channel.socketPath);
    await Promise.race([
      second.closed,
      Bun.sleep(500).then(() => {
        throw new Error("extra connection was not rejected");
      }),
    ]);

    first.write({ jsonrpc: "2.0", id: 1, method: "log", params: { level: "info" } });
    expect(await first.next()).toMatchObject({ id: 1, result: null });
    expect(calls).toBe(1);

    first.socket.end();
    second.socket.end();
  });
});
