import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type PluginDefinition } from "./hooks.ts";
import { encodeFrame, FrameDecoder, isResponse, type JsonRpcResponse } from "./protocol.ts";
import { type PluginServer, servePlugin } from "./runtime.ts";

const servers: Array<{ stop(force?: boolean): void }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

interface TestBroker {
  readonly socketPath: string;
  readonly hello: Promise<Record<string, unknown>>;
  readonly request: (method: string, params?: unknown) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

async function startBroker(): Promise<TestBroker> {
  const socketPath = join(tmpdir(), `plugin-sdk-${randomUUID()}.sock`);
  const decoder = new FrameDecoder();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  let nextId = 0;
  let resolveHello: (value: Record<string, unknown>) => void = () => undefined;
  const hello = new Promise<Record<string, unknown>>((resolve) => {
    resolveHello = resolve;
  });
  let socket: Bun.Socket | undefined;

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(connected) {
        socket = connected;
      },
      data(_socket, data) {
        for (const message of decoder.push(data)) {
          if (isResponse(message)) {
            pending.get(Number(message.id))?.(message);
            pending.delete(Number(message.id));
            continue;
          }

          const record = message as { method?: string; params?: unknown };

          if (record.method === "hello") {
            resolveHello((record.params ?? {}) as Record<string, unknown>);
          }
        }
      },
      error() {},
      close() {},
    },
  });
  servers.push(server);

  return {
    socketPath,
    hello,
    request(method, params) {
      const id = ++nextId;
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`No response for ${method}`));
        }, 2_000);
        timer.unref?.();
        pending.set(id, (message) => {
          clearTimeout(timer);

          if (message.error !== undefined) {
            reject(new Error(message.error.message));
            return;
          }

          resolve(message.result);
        });
      });
      socket?.write(encodeFrame({ jsonrpc: "2.0", id, method, params: params ?? null }));
      return response;
    },
    async close() {
      server.stop(true);
      await unlink(socketPath).catch(() => undefined);
    },
  };
}

const definition: PluginDefinition = definePlugin({
  id: "test-plugin",
  version: "1.0.0",
  hooks: {
    enrichers: {
      "topic.view": {
        fields: ["tipTotal"],
        deps: ["tips"],
        handler: ({ view }) => ({
          fields: { tipTotal: Number(view.posts ?? 0) * 5 },
          tags: ["tips"],
        }),
      },
    },
    filters: {
      "post.write": {
        handler: ({ content }) => content.replaceAll("teh", "the"),
      },
    },
    vetoes: {
      "post.write": {
        reasonKey: "plugin.spam.reason",
        handler: ({ content }) =>
          content.includes("buy now")
            ? { allow: false, reasonKey: "plugin.spam.reason" }
            : { allow: true },
      },
    },
  },
  events: {
    "topic.created": () => undefined,
  },
  jobs: {
    leaderboard: () => undefined,
  },
  contentExtensions: {
    tip: ({ source }) => ({ html: `<span class="tip">${source}</span>` }),
  },
  routes: {
    "tip/:postId": ({ method, viewer }) => ({
      status: 200,
      body: `${method}:${viewer.memberId ?? "guest"}`,
    }),
  },
  gdpr: {
    export: ({ memberId }) => ({ data: { memberId } }),
    erase: () => undefined,
  },
  clientApps: [{ name: "tip-jar", entry: "client/index.js", hooks: ["post.userbar"] }],
});

let plugin: PluginServer | undefined;

async function connect(broker: TestBroker): Promise<void> {
  plugin = await servePlugin(definition, {
    socketPath: broker.socketPath,
    pluginId: "test-plugin",
  });
}

describe("plugin SDK runtime", () => {
  test("completes the hello and describes its hooks", async () => {
    const broker = await startBroker();
    await connect(broker);

    expect(await broker.hello).toEqual({ pluginId: "test-plugin", sdkVersion: "2.0.0" });
    const description = (await broker.request("plugin.describe")) as Record<string, unknown>;
    expect(description).toMatchObject({
      id: "test-plugin",
      enrichers: [{ fields: ["tipTotal"], deps: ["tips"] }],
      events: ["topic.created"],
      clientApps: [{ name: "tip-jar" }],
    });

    plugin?.close();
    await broker.close();
  });

  test("serves enrichers, filters, vetoes, extensions, routes and GDPR handlers", async () => {
    const broker = await startBroker();
    await connect(broker);
    await broker.hello;

    expect(
      await broker.request("hook.enrich", { hook: "topic.view", route: "/", view: { posts: 2 } }),
    ).toEqual({ fields: { tipTotal: 10 }, tags: ["tips"] });

    expect(
      await broker.request("hook.filter", {
        hook: "post.write",
        content: "teh cat",
        context: { authorId: "1" },
      }),
    ).toEqual({ content: "the cat" });

    expect(
      await broker.request("hook.veto", {
        hook: "post.write",
        content: "buy now",
        context: { authorId: "1" },
      }),
    ).toEqual({ allow: false, reasonKey: "plugin.spam.reason" });

    expect(
      await broker.request("content.extend", {
        syntax: "tip",
        source: "x",
        viewer: { memberId: null },
      }),
    ).toEqual({ html: '<span class="tip">x</span>' });

    expect(
      await broker.request("route.request", {
        path: "tip/:postId",
        method: "GET",
        viewer: { memberId: "7" },
      }),
    ).toEqual({ status: 200, body: "GET:7" });

    expect(await broker.request("gdpr.export", { memberId: "9" })).toEqual({
      data: { memberId: "9" },
    });
    expect(await broker.request("gdpr.erase", { memberId: "9" })).toBeNull();

    plugin?.close();
    await broker.close();
  });

  test("returns a JSON-RPC error for an unknown hook method", async () => {
    const broker = await startBroker();
    await connect(broker);

    await expect(broker.request("hook.unknown")).rejects.toThrow("Unknown hook method");

    plugin?.close();
    await broker.close();
  });
});
