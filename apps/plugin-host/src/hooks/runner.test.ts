import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import { type PluginManifest, parsePluginManifest } from "@bulletin/plugin-sdk/manifest";
import { PluginHookRegistry, pluginTag } from "./registry.ts";
import { type HookTransport, PluginHookRunner } from "./runner.ts";

const logger = createLogger({ service: "hook-test", level: "error", sink: () => {} });

const BASE = {
  name: "Test",
  version: "1.0.0",
  sdkVersion: "^2.0.0",
  entry: "server.ts",
};

function manifest(overrides: Record<string, unknown>): PluginManifest {
  const capabilities =
    Array.isArray(overrides.vetoes) && !Array.isArray(overrides.capabilities)
      ? ["veto"]
      : overrides.capabilities;

  return parsePluginManifest({
    ...BASE,
    ...overrides,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

function plugin(id: string, overrides: Record<string, unknown> = {}): PluginManifest {
  return manifest({ id, ...overrides });
}

function registry(...plugins: PluginManifest[]): PluginHookRegistry {
  const value = new PluginHookRegistry();

  for (const [index, item] of plugins.entries()) {
    value.install(item, { generation: index + 1 });
  }

  return value;
}

interface FakeTransport extends HookTransport {
  readonly calls: Array<{ method: string; params: unknown; timeoutMs: number | undefined }>;
}

function transport(
  handler: (method: string, params: unknown) => Promise<unknown> | unknown,
): FakeTransport {
  const calls: FakeTransport["calls"] = [];

  return {
    calls,
    request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
      calls.push({ method, params, timeoutMs });
      return Promise.resolve(handler(method, params) as T);
    },
  };
}

function runner(
  registryValue: PluginHookRegistry,
  transportValue: HookTransport,
): PluginHookRunner {
  return new PluginHookRunner({ transport: transportValue, registry: registryValue, logger });
}

describe("plugin hook registry", () => {
  test("orders filters by priority and ignores disabled plugins", () => {
    const hooks = registry(
      plugin("b", {
        filters: [{ hook: "post.write", priority: 20 }],
        vetoes: [{ hook: "post.write", reasonKey: "b.reason" }],
      }),
      plugin("a", {
        filters: [{ hook: "post.write", priority: 10 }],
        vetoes: [{ hook: "post.write", reasonKey: "a.reason" }],
      }),
    );

    expect(hooks.filters("post.write").map((entry) => entry.pluginId)).toEqual(["a", "b"]);
    expect(hooks.vetoes("post.write").map((entry) => entry.pluginId)).toEqual(["a", "b"]);
    expect(hooks.generation()).toBe(2);

    hooks.setEnabled("a", false);
    expect(hooks.filters("post.write").map((entry) => entry.pluginId)).toEqual(["b"]);
  });

  test("lists event, content, route and client registrations in plugin order", () => {
    const hooks = registry(
      plugin("tips", {
        events: ["topic.created"],
        contentExtensions: ["tip"],
        routes: [{ path: "leaderboard", kind: "page" }],
      }),
      plugin("welcome", { events: ["topic.created"] }),
    );

    expect(hooks.subscribedTo("topic.created")).toEqual(["tips", "welcome"]);
    expect(hooks.contentExtensions("tip")).toEqual(["tips"]);
    expect(hooks.routes("page")).toEqual([{ pluginId: "tips", path: "leaderboard" }]);
    expect(hooks.routes("api")).toEqual([]);
  });

  test("namespaces plugin tags and never lets a plugin escape its namespace", () => {
    expect(pluginTag("tips", "leaderboard")).toBe("plugin:tips:leaderboard");
    expect(pluginTag("tips", "plugin:other:leaderboard")).toBe("plugin:tips:leaderboard");
  });
});

describe("view-model enrichers", () => {
  test("merges declared fields and namespaced dependency tags", async () => {
    const hooks = registry(
      plugin("tips", {
        enrichers: [
          { hook: "topic.view", fields: ["tipTotal", "tipLabel"], deps: ["leaderboard"] },
        ],
      }),
    );
    const fake = transport(() => ({
      fields: { tipTotal: 12, tipLabel: "12 tips", secret: "staff-only" },
      tags: ["tips"],
    }));

    const result = await runner(hooks, fake).enrich({
      hook: "topic.view",
      route: "topic",
      view: { topicId: "1" },
      viewer: { memberId: null },
    });

    expect(result.fields).toEqual({ tipTotal: 12, tipLabel: "12 tips" });
    expect(result.tags).toEqual(["plugin:tips:leaderboard", "plugin:tips:tips"]);
    expect(result.failures).toEqual([]);
    expect(fake.calls[0]).toMatchObject({ method: "hook.enrich", timeoutMs: 100 });
  });

  test("does not dispatch to a disabled plugin", async () => {
    const hooks = registry(
      plugin("tips", { enrichers: [{ hook: "topic.view", fields: ["tipTotal"] }] }),
    );
    const fake = transport(() => ({ fields: { tipTotal: 1 } }));
    const disabled = new PluginHookRunner({
      transport: fake,
      registry: hooks,
      logger,
      isActive: async () => false,
    });

    const result = await disabled.enrich({
      hook: "topic.view",
      route: "topic",
      view: {},
      viewer: { memberId: "1" },
    });

    expect(result.fields).toEqual({});
    expect(fake.calls).toEqual([]);
  });

  test("leaves the field empty when an enricher times out or fails", async () => {
    const hooks = registry(
      plugin("slow", {
        enrichers: [{ hook: "topic.view", fields: ["slowField"] }],
      }),
    );
    const fake = transport(() => {
      throw new Error("timed out");
    });

    const result = await runner(hooks, fake).enrich({
      hook: "topic.view",
      route: "topic",
      view: {},
      viewer: { memberId: "1" },
    });

    expect(result.fields).toEqual({});
    expect(result.failures).toEqual(["slow"]);
  });
});

describe("write filters and vetoes", () => {
  test("runs transforms in priority order within the shared 300 ms budget", async () => {
    const hooks = registry(
      plugin("second", {
        filters: [{ hook: "post.write", priority: 20 }],
      }),
      plugin("first", { filters: [{ hook: "post.write", priority: 10 }] }),
    );
    let index = 0;
    const ordered = transport(() => ({ content: `step${String(++index)}` }));
    const result = await runner(hooks, ordered).filter({
      hook: "post.write",
      content: "hello",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
    });

    expect(result.content).toBe("step2");
    expect(ordered.calls[0]?.timeoutMs).toBeLessThanOrEqual(300);
    expect(ordered.calls[0]?.timeoutMs).toBeGreaterThan(250);
    expect(ordered.calls[1]?.timeoutMs).toBeLessThanOrEqual(300);
  });

  test("skips a filter that throws and still saves", async () => {
    const hooks = registry(plugin("broken", { filters: [{ hook: "post.write" }] }));
    const fake = transport(() => {
      throw new Error("boom");
    });

    const result = await runner(hooks, fake).filter({
      hook: "post.write",
      content: "hello",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
    });

    expect(result.content).toBe("hello");
    expect(result.failures).toEqual(["broken"]);
  });

  test("skips filters that miss the total budget", async () => {
    const hooks = registry(
      plugin("slow", { filters: [{ hook: "post.write", priority: 1 }] }),
      plugin("next", { filters: [{ hook: "post.write", priority: 2 }] }),
    );
    let call = 0;
    const fake = transport(async () => {
      call += 1;
      await Bun.sleep(call === 1 ? 40 : 0);
      return { content: "changed" };
    });

    const result = await runner(hooks, fake).filter({
      hook: "post.write",
      content: "hello",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
      budgetMs: 20,
    });

    expect(result.timedOut).toContain("next");
    expect(result.content).toBe("changed");
  });

  test("rejects with a translated reason when a veto says no", async () => {
    const hooks = registry(
      plugin("spam", {
        vetoes: [{ hook: "post.write", reasonKey: "plugin.spam.reason" }],
      }),
    );
    const fake = transport(() => ({ allow: false, reasonKey: "plugin.spam.reason" }));

    const result = await runner(hooks, fake).filter({
      hook: "post.write",
      content: "buy now",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
    });

    expect(result.veto).toEqual({ reasonKey: "plugin.spam.reason", pluginId: "spam" });
  });

  test("falls back to the manifest reason when the handler omits one", async () => {
    const hooks = registry(
      plugin("spam", {
        vetoes: [{ hook: "post.write", reasonKey: "plugin.spam.reason" }],
      }),
    );
    const fake = transport(() => ({ allow: false }));

    const result = await runner(hooks, fake).filter({
      hook: "post.write",
      content: "buy now",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
    });

    expect(result.veto).toEqual({ reasonKey: "plugin.spam.reason", pluginId: "spam" });
  });

  test("a fail-open veto that is down allows the write", async () => {
    const hooks = registry(
      plugin("spam", {
        vetoes: [{ hook: "post.write", reasonKey: "plugin.spam.reason", failMode: "open" }],
      }),
    );
    const fake = transport(() => {
      throw new Error("down");
    });

    const result = await runner(hooks, fake).filter({
      hook: "post.write",
      content: "hello",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
    });

    expect(result.veto).toBeUndefined();
    expect(result.timedOut).toEqual(["spam"]);
  });

  test("a fail-closed veto that is down rejects with temporarily unavailable", async () => {
    const hooks = registry(
      plugin("spam", {
        vetoes: [{ hook: "post.write", reasonKey: "plugin.spam.reason", failMode: "closed" }],
      }),
    );
    const fake = transport(() => {
      throw new Error("down");
    });

    const result = await runner(hooks, fake).filter({
      hook: "post.write",
      content: "hello",
      context: { authorId: "1" },
      viewer: { memberId: "1" },
    });

    expect(result.veto).toEqual({
      reasonKey: "plugin.veto.unavailable",
      pluginId: "spam",
    });
  });
});
