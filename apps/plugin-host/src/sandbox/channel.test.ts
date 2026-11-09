import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@bulletin/config";
import { BrokerChannel } from "./channel.ts";

const logger = createLogger({ service: "broker-test", level: "error", sink: () => {} });
const temporaryDirectories: string[] = [];

async function createChannel(maxLineBytes?: number): Promise<BrokerChannel> {
  const directory = await mkdtemp(join(tmpdir(), "bulletin-broker-"));
  temporaryDirectories.push(directory);
  const channel = new BrokerChannel({
    socketPath: join(directory, "broker.sock"),
    logger,
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
  });
  await channel.start();
  return channel;
}

async function connectAndSend(socketPath: string, text: string): Promise<Bun.Socket> {
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data() {
        // Replies are not used by the handshake.
      },
      error() {
        // Closed on purpose at the end of each test.
      },
    },
  });

  socket.write(text);
  return socket;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("broker channel handshake", () => {
  test("accepts a hello from the plugin", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const socket = await connectAndSend(
      channel.socketPath,
      `${JSON.stringify({ type: "hello", pluginId: "sandbox-demo", sdkVersion: "0.0.0" })}\n`,
    );

    await expect(hello).resolves.toEqual({
      type: "hello",
      pluginId: "sandbox-demo",
      sdkVersion: "0.0.0",
    });

    socket.end();
    await channel.close();
  });

  test("rejects when no plugin connects in time", async () => {
    const channel = await createChannel();

    await expect(channel.waitForHello(30)).rejects.toThrow("No broker handshake within 30 ms");

    await channel.close();
  });

  test("rejects malformed messages instead of buffering them", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const socket = await connectAndSend(channel.socketPath, "not-json\n");

    await expect(hello).rejects.toThrow("invalid broker message");

    socket.end();
    await channel.close();
  });

  test("bounds the line buffer", async () => {
    const channel = await createChannel(16);
    const hello = channel.waitForHello(2_000);
    const socket = await connectAndSend(channel.socketPath, "x".repeat(64));

    await expect(hello).rejects.toThrow("oversized broker message");

    socket.end();
    await channel.close();
  });

  test("rejects a disconnected plugin", async () => {
    const channel = await createChannel();
    const hello = channel.waitForHello(2_000);
    const socket = await connectAndSend(channel.socketPath, "");

    socket.end();

    await expect(hello).rejects.toThrow("disconnected before the broker handshake");

    await channel.close();
  });

  test("allows only one pending handshake", async () => {
    const channel = await createChannel();
    const first = channel.waitForHello(2_000);

    await expect(channel.waitForHello(2_000)).rejects.toThrow("already pending");

    await first.catch(() => undefined);
    await channel.close();
  });
});
