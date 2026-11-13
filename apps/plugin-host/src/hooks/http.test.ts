import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@bulletin/config";
import { type PluginManifest, parsePluginManifest } from "@bulletin/plugin-sdk/manifest";
import { readInternal, serveClientApp } from "./http.ts";
import { PluginHookRegistry } from "./registry.ts";
import { type HookTransport, PluginHookRunner } from "./runner.ts";

const logger = createLogger({ service: "hooks-http-test", level: "error", sink: () => {} });
const TOKEN = "internal-secret";

function manifest(): PluginManifest {
  return parsePluginManifest({
    id: "tips",
    name: "Tips",
    version: "1.0.0",
    sdkVersion: "^2.0.0",
    entry: "server.ts",
    capabilities: ["enricher", "filter", "veto", "events", "route", "client"],
    enrichers: [{ hook: "home.view", fields: ["tipTotal"] }],
    filters: [{ hook: "post.write" }],
    vetoes: [{ hook: "post.write", reasonKey: "plugin.tips.no" }],
    events: ["topic.created"],
    contentExtensions: ["tip"],
    routes: [{ path: "tip", kind: "api" }],
    clientApps: [{ name: "tip", entry: "client/index.html", hooks: ["post.userbar"] }],
  });
}

function transport(handler: (method: string, params: unknown) => unknown): HookTransport {
  return { request: async <T>(method: string, params: unknown) => handler(method, params) as T };
}

function options(bundles = new Map<string, { manifest: PluginManifest; path: string }>()) {
  const registry = new PluginHookRegistry();
  registry.install(manifest(), { generation: 3 });
  const transportValue = transport((method) => {
    switch (method) {
      case "hook.enrich":
        return { fields: { tipTotal: 7 }, tags: ["plugin:tips:tips"] };
      case "hook.filter":
        return { content: "filtered" };
      case "hook.veto":
        return { allow: true };
      case "event.deliver":
      case "job.run":
        return null;
      case "content.extend":
        return { html: "<b>tip</b>" };
      case "route.request":
      case "bridge.request":
        return { status: 200, body: "viewer:guest", headers: {} };
      default:
        throw new Error(`unexpected ${method}`);
    }
  });

  return {
    runner: new PluginHookRunner({ transport: transportValue, registry, logger }),
    registry,
    transport: transportValue,
    token: TOKEN,
    frameAncestors: ["http://bulletin.localhost:18080"],
    logger,
    bundles,
  };
}

function request(path: string, body: unknown, token = TOKEN): Request {
  return new Request(`http://plugin-host:3004${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("plugin-host internal hook API", () => {
  test("requires the internal token", async () => {
    const response = await readInternal(request("/internal/enrich", {}, "wrong"), options());
    expect(response?.status).toBe(401);
  });

  test("serves enrich, filter, content, events, routes and registry", async () => {
    const opts = options();

    const enrich = await readInternal(
      request("/internal/enrich", { hook: "home.view", route: "home", view: {}, viewer: {} }),
      opts,
    );
    expect(await enrich?.json()).toEqual({
      fields: { tipTotal: 7 },
      tags: ["plugin:tips:tips"],
      failures: [],
    });

    const filter = await readInternal(
      request("/internal/filter", {
        hook: "post.write",
        content: "hello",
        context: { authorId: "1" },
        viewer: { memberId: "1" },
      }),
      opts,
    );
    expect(await filter?.json()).toEqual({ content: "filtered", failures: [], timedOut: [] });

    const content = await readInternal(
      request("/internal/content-extend", { syntax: "tip", source: "5", viewer: {} }),
      opts,
    );
    expect(await content?.json()).toEqual({ html: "<b>tip</b>" });

    const events = await readInternal(
      request("/internal/events", {
        type: "topic.created",
        eventId: "1",
        payloadIds: { topicId: "2" },
      }),
      opts,
    );
    expect(await events?.json()).toEqual({ delivered: 1, failures: [] });

    const routes = await readInternal(
      request("/internal/routes", { pluginId: "tips", path: "tip", method: "GET", viewer: {} }),
      opts,
    );
    expect(await routes?.json()).toEqual({ status: 200, body: "viewer:guest", headers: {} });

    const registry = await readInternal(
      new Request("http://plugin-host:3004/internal/registry", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      opts,
    );
    const body = (await registry?.json()) as { generation: number; plugins: unknown[] };
    expect(body.generation).toBe(3);
  });

  test("rejects malformed filter input", async () => {
    const response = await readInternal(
      request("/internal/filter", { hook: "post.write" }),
      options(),
    );
    expect(response?.status).toBe(400);
  });
});

describe("plugin client app serving", () => {
  test("serves only declared entries from the bundle", async () => {
    const path = await mkdtemp(join(tmpdir(), "plugin-app-"));

    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(path, "client"), { recursive: true });
      await writeFile(join(path, "client/index.html"), "<html>tip</html>");
      const bundles = new Map([["tips", { manifest: manifest(), path }]]);

      const served = await serveClientApp(
        new URL("http://plugins.bulletin.localhost:18080/apps/tips/1/client/index.html"),
        bundles,
        ["http://bulletin.localhost:18080"],
      );
      expect(served?.status).toBe(200);
      expect(await served?.text()).toContain("tip");
      expect(served?.headers.get("content-security-policy")).toContain(
        "frame-ancestors http://bulletin.localhost:18080",
      );

      const undeclared = await serveClientApp(
        new URL("http://plugins.bulletin.localhost:18080/apps/tips/1/client/../secret"),
        bundles,
        [],
      );
      expect(undeclared?.status).toBe(404);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});
