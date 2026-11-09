import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@bulletin/config";
import { BrokerChannel, type BrokerHandler } from "./channel.ts";
import { encodeFrame, FrameDecoder, RpcError } from "./protocol.ts";

const logger = createLogger({ service: "broker-test", level: "error", sink: () => {} });
const channels: BrokerChannel[] = [];
const directories: string[] = [];

async function createChannel(handler?: BrokerHandler): Promise<BrokerChannel> {
  const directory = await mkdtemp(join(tmpdir(), "bulletin-broker-"));
  directories.push(directory);
  const channel = new BrokerChannel({
    socketPath: join(directory, "broker.sock"),
    logger,
    ...(handler === undefined ? {} : { handler }),
  });
  await channel.start();
  channels.push(channel);
  return channel;
}

interface Client {
  readonly socket: { write(data: Uint8Array): void; end(): void };
  write(value: unknown): void;
  writeRaw(frame: Uint8Array): void;
  next(): Promise<unknown>;
}

async function connect(socketPath: string): Promise<Client> {
  const decoder = new FrameDecoder();
  const messages: unknown[] = [];
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
      error() {},
    },
  });

  return {
    socket,
    write(value) {
      socket.write(encodeFrame(value));
    },
    writeRaw(frame) {
      socket.write(frame);
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
});
