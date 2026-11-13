import { posix } from "node:path";
import type { Logger } from "@bulletin/config";
import type { ViewerContext } from "@bulletin/plugin-sdk/hooks";
import type { PluginManifest } from "@bulletin/plugin-sdk/manifest";
import type { PluginHookRegistry } from "./registry.ts";
import type { HookTransport, PluginHookRunner } from "./runner.ts";

/**
 * Core→plugin-host internal API. user-api, user-app and workers call these with the shared
 * internal token; a sandbox never sees this HTTP surface. Viewer context is always supplied by
 * the trusted core caller, never by plugin code.
 */

export interface HookHttpOptions {
  readonly runner: PluginHookRunner;
  readonly registry: PluginHookRegistry;
  readonly transport: HookTransport;
  /** Per-plugin authenticated transport; the single transport is a test-only fallback. */
  readonly transports?: ReadonlyMap<string, HookTransport>;
  readonly canReadContent?: (pluginId: string, forumId: string) => Promise<boolean>;
  readonly isPluginActive?: (pluginId: string) => Promise<boolean>;
  readonly token: string;
  readonly frameAncestors: readonly string[];
  readonly logger: Logger;
  readonly bundles: ReadonlyMap<
    string,
    { readonly manifest: PluginManifest; readonly path: string }
  >;
}

interface Envelope {
  readonly [key: string]: unknown;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function viewer(value: unknown): ViewerContext {
  if (!isRecord(value)) {
    return { memberId: null };
  }

  return {
    memberId: typeof value.memberId === "string" ? value.memberId : null,
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
  };
}

async function body(request: Request): Promise<Envelope | null> {
  try {
    const value: unknown = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function readInternal(
  request: Request,
  options: HookHttpOptions,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (!url.pathname.startsWith("/internal/")) {
    return undefined;
  }

  if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
    return json({ code: "unauthorized" }, 401);
  }

  if (url.pathname === "/internal/registry" && request.method === "GET") {
    return json({
      plugins: [...options.bundles.entries()].map(([id, bundle]) => ({
        id,
        version: bundle.manifest.version,
        hooks: {
          enrichers: bundle.manifest.enrichers,
          filters: bundle.manifest.filters,
          vetoes: bundle.manifest.vetoes,
          events: bundle.manifest.events,
          routes: bundle.manifest.routes,
          jobs: bundle.manifest.jobs,
          contentExtensions: bundle.manifest.contentExtensions,
          clientApps: bundle.manifest.clientApps,
        },
      })),
      generation: options.registry.generation(),
    });
  }

  const transportFor = (pluginId: string): HookTransport | undefined =>
    options.transports === undefined ? options.transport : options.transports.get(pluginId);

  if (request.method !== "POST") {
    return json({ code: "method_not_allowed" }, 405);
  }

  const input = await body(request);

  if (input === null) {
    return json({ code: "invalid_request" }, 400);
  }

  switch (url.pathname) {
    case "/internal/enrich": {
      if (
        typeof input.hook !== "string" ||
        typeof input.route !== "string" ||
        !isRecord(input.view)
      ) {
        return json({ code: "invalid_request" }, 400);
      }

      const result = await options.runner.enrich({
        hook: input.hook,
        route: input.route,
        view: input.view,
        viewer: viewer(input.viewer),
      });
      return json(result);
    }

    case "/internal/filter": {
      if (
        typeof input.hook !== "string" ||
        typeof input.content !== "string" ||
        !isRecord(input.context)
      ) {
        return json({ code: "invalid_request" }, 400);
      }

      const context = input.context;
      const authorId = typeof context.authorId === "string" ? context.authorId : "";

      if (authorId === "") {
        return json({ code: "invalid_request" }, 400);
      }

      const result = await options.runner.filter({
        hook: input.hook,
        content: input.content,
        context: {
          authorId,
          ...(typeof context.forumId === "string" ? { forumId: context.forumId } : {}),
          ...(typeof context.topicId === "string" ? { topicId: context.topicId } : {}),
          ...(typeof context.postId === "string" ? { postId: context.postId } : {}),
        },
        viewer: viewer(input.viewer),
      });
      return json(result);
    }

    case "/internal/events": {
      if (typeof input.type !== "string" || typeof input.eventId !== "string") {
        return json({ code: "invalid_request" }, 400);
      }

      const pluginIds = Array.isArray(input.pluginIds)
        ? input.pluginIds.filter((id): id is string => typeof id === "string")
        : options.registry.subscribedTo(input.type);
      const failures: string[] = [];

      await Promise.all(
        pluginIds.map(async (pluginId) => {
          try {
            const transport = transportFor(pluginId);

            if (transport === undefined) {
              throw new Error("No sandbox for plugin");
            }

            await transport.request(
              "event.deliver",
              {
                type: input.type,
                eventId: input.eventId,
                payloadIds: isRecord(input.payloadIds) ? input.payloadIds : {},
              },
              2_000,
            );
          } catch (error) {
            failures.push(pluginId);
            options.logger.warn("plugin.event_delivery_failed", { pluginId, error });
          }
        }),
      );

      return json({ delivered: pluginIds.length - failures.length, failures });
    }

    case "/internal/jobs": {
      if (typeof input.pluginId !== "string" || typeof input.name !== "string") {
        return json({ code: "invalid_request" }, 400);
      }

      try {
        const transport = transportFor(input.pluginId);

        if (transport === undefined) {
          return json({ ok: false, code: "not_found" }, 404);
        }

        await transport.request(
          "job.run",
          { name: input.name, payload: isRecord(input.payload) ? input.payload : {} },
          5_000,
        );
        return json({ ok: true });
      } catch (error) {
        options.logger.warn("plugin.job_failed", { pluginId: input.pluginId, error });
        return json({ ok: false }, 500);
      }
    }

    case "/internal/content-extend": {
      if (typeof input.syntax !== "string" || typeof input.source !== "string") {
        return json({ code: "invalid_request" }, 400);
      }

      const html: string[] = [];
      const syntaxes =
        input.syntax === "*"
          ? [
              ...new Set(
                options.registry.plugins().flatMap((plugin) => plugin.manifest.contentExtensions),
              ),
            ]
          : [input.syntax];

      const forumId =
        isRecord(input.context) && typeof input.context.forumId === "string"
          ? input.context.forumId
          : undefined;

      for (const syntax of syntaxes) {
        for (const pluginId of options.registry.contentExtensions(syntax)) {
          const plugin = options.registry.get(pluginId);

          if (
            plugin === undefined ||
            !plugin.enabled ||
            (options.isPluginActive !== undefined && !(await options.isPluginActive(pluginId)))
          ) {
            continue;
          }

          if (
            forumId !== undefined &&
            options.canReadContent !== undefined &&
            !(await options.canReadContent(pluginId, forumId))
          ) {
            continue;
          }

          try {
            const result = await options.transport.request<{ html?: unknown }>(
              "content.extend",
              { syntax, source: input.source, viewer: viewer(input.viewer) },
              200,
            );
            const rendered = isRecord(result) && typeof result.html === "string" ? result.html : "";

            if (rendered !== "") {
              html.push(rendered);
            }
          } catch (error) {
            options.logger.warn("plugin.content_extension_failed", { pluginId, error });
          }
        }
      }

      return json({ html: html.join("") });
    }

    case "/internal/routes":
    case "/internal/bridge": {
      if (typeof input.pluginId !== "string" || typeof input.path !== "string") {
        return json({ code: "invalid_request" }, 400);
      }

      const plugin = options.registry.get(input.pluginId);
      const transport = transportFor(input.pluginId);

      if (
        plugin === undefined ||
        !plugin.enabled ||
        transport === undefined ||
        (options.isPluginActive !== undefined && !(await options.isPluginActive(input.pluginId)))
      ) {
        return json({ code: "not_found" }, 404);
      }

      if (!plugin.manifest.routes.some((route) => route.path === input.path)) {
        return json({ code: "not_found" }, 404);
      }

      try {
        const requestPayload = {
          method: typeof input.method === "string" ? input.method : "GET",
          path: input.path,
          query: isRecord(input.query) ? input.query : {},
          body: typeof input.body === "string" ? input.body : null,
          viewer: viewer(input.viewer),
        };
        const method = url.pathname === "/internal/bridge" ? "bridge.request" : "route.request";
        const result =
          transport.requestWithContext === undefined
            ? await transport.request(method, requestPayload, 3_000)
            : await transport.requestWithContext(
                method,
                requestPayload,
                viewer(input.viewer),
                3_000,
              );
        return json(result);
      } catch (error) {
        options.logger.warn("plugin.route_failed", { pluginId: input.pluginId, error });
        return json({ status: 503, body: "Plugin unavailable" }, 200);
      }
    }

    default:
      return json({ code: "not_found" }, 404);
  }
}

/** Serves a plugin client app from its bundle on the plugin origin (ADR 0009, 0018). */
export async function serveClientApp(
  url: URL,
  bundles: HookHttpOptions["bundles"],
  frameAncestors: readonly string[],
): Promise<Response | undefined> {
  const match = /^\/apps\/([a-z0-9][a-z0-9-]{0,48})\/(\d+)\/(.+)$/.exec(url.pathname);

  if (match === null) {
    return undefined;
  }

  const [, pluginId, , entry] = match;
  const bundle = pluginId === undefined ? undefined : bundles.get(pluginId);

  if (bundle === undefined || entry === undefined) {
    return new Response("Not found", { status: 404 });
  }

  const requested = decodeURIComponent(entry);
  const app = bundle.manifest.clientApps.find((candidate) => {
    const directory = posix.dirname(candidate.entry);
    return requested === candidate.entry || requested.startsWith(`${directory}/`);
  });

  if (app === undefined || requested.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  const file = Bun.file(`${bundle.path}/${requested}`);

  if (!(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": file.type || "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    // A sandboxed frame has an opaque origin, where `'self'` does not match its own assets.
    // The explicit plugin origin keeps scripts/styles same-origin while still bounding fetches.
    "content-security-policy": `default-src 'none'; script-src ${url.origin}; style-src ${url.origin} 'unsafe-inline'; img-src ${url.origin} data:; connect-src 'none'; frame-ancestors ${frameAncestors.join(" ")}`,
    "referrer-policy": "no-referrer",
  });

  return new Response(file, { headers });
}

export { readInternal };
