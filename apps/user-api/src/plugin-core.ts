import { createHmac, timingSafeEqual } from "node:crypto";
import {
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { readPostContext } from "@bulletin/domain/topics";
import type { SQL } from "bun";

/** Authenticated broker→core forwarding endpoint (ADR 0009, task 2.2/3.9). */

const MAX_BODY_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface PluginCoreOptions {
  readonly token: string;
  readonly now?: () => number;
}

interface ViewerInput {
  readonly memberId?: unknown;
  readonly sessionId?: unknown;
}

function unauthorized(message: string): Response {
  return Response.json({ code: "unauthorized", message }, { status: 401 });
}

function denied(message: string): Response {
  return Response.json({ code: "forbidden", message }, { status: 403 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coreSignature(
  token: string,
  pluginId: string,
  timestamp: string,
  body: string,
): string {
  return createHmac("sha256", token).update(`${pluginId}\n${timestamp}\n${body}`).digest("hex");
}

export async function pluginCoreResponse(
  sql: SQL,
  request: Request,
  options: PluginCoreOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ code: "method_not_allowed" }, { status: 405 });
  }

  const pluginId = request.headers.get("x-bulletin-plugin") ?? "";
  const timestamp = request.headers.get("x-bulletin-timestamp") ?? "";
  const signature = request.headers.get("x-bulletin-signature") ?? "";
  const now = options.now?.() ?? Date.now();
  const sentAt = Number(timestamp);

  if (
    !/^[a-z0-9][a-z0-9-]{0,48}$/.test(pluginId) ||
    !Number.isSafeInteger(sentAt) ||
    Math.abs(now - sentAt) > MAX_CLOCK_SKEW_MS ||
    request.headers.get("authorization") !== `Bearer ${options.token}`
  ) {
    return unauthorized("Broker credentials are missing or stale");
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return Response.json({ code: "payload_too_large" }, { status: 413 });
  }

  const expected = coreSignature(options.token, pluginId, timestamp, text);

  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return unauthorized("Broker signature is not valid");
  }

  let input: unknown;

  try {
    input = JSON.parse(text);
  } catch {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }

  if (!isRecord(input) || typeof input.method !== "string") {
    return Response.json({ code: "invalid_request" }, { status: 400 });
  }

  const pluginRows = (await sql`
    SELECT capabilities, enabled, state, service_principal_group, elevated_grants
    FROM core.plugins WHERE plugin_id = ${pluginId}
  `) as Array<{
    capabilities: unknown;
    enabled: boolean;
    state: string;
    service_principal_group: string;
    elevated_grants: unknown;
  }>;
  const plugin = pluginRows[0];

  if (plugin === undefined) {
    return denied("Plugin is not installed");
  }

  if (!plugin.enabled || plugin.state !== "active") {
    return denied("Plugin is disabled");
  }

  const capabilities = Array.isArray(plugin.capabilities)
    ? plugin.capabilities.filter((value): value is string => typeof value === "string")
    : [];

  if (!capabilities.includes("core.read") && !capabilities.includes("core.write")) {
    return denied("Plugin has no core-data capability");
  }

  const viewerInput = isRecord(input.viewer) ? (input.viewer as ViewerInput) : {};
  const memberId = typeof viewerInput.memberId === "string" ? viewerInput.memberId : null;
  const sessionId = typeof viewerInput.sessionId === "string" ? viewerInput.sessionId : null;
  const viewerPrincipal = memberId === null ? GUEST_PRINCIPAL : memberId;
  const grants = Array.isArray(plugin.elevated_grants)
    ? plugin.elevated_grants
        .map((entry) => (isRecord(entry) && typeof entry.forumId === "string" ? entry.forumId : ""))
        .filter((id) => id !== "")
    : [];

  try {
    switch (input.method) {
      case "posts.get": {
        const params = isRecord(input.params) ? input.params : {};
        const postId = typeof params.postId === "string" ? params.postId : "";
        const post = await readPostContext(sql, postId);

        if (post === null) {
          return Response.json({ code: "not_found" }, { status: 404 });
        }

        const tree = await loadForumTree(sql);
        const viewerSnapshot = await loadPermissionSnapshot(sql, viewerPrincipal, {
          tree,
          sessionId,
        });
        const guestSnapshot = await loadPermissionSnapshot(sql, GUEST_PRINCIPAL, { tree });

        const viewerAllowed =
          (await can(sql, viewerPrincipal, "read", {
            forumId: post.forumId,
            tree,
            snapshot: viewerSnapshot,
          })) &&
          (post.visibility === "visible" ||
            (post.visibility === "unapproved" &&
              (await can(sql, viewerPrincipal, "see_unapproved", {
                forumId: post.forumId,
                tree,
                snapshot: viewerSnapshot,
              }))) ||
            (post.visibility === "soft_deleted" &&
              (await can(sql, viewerPrincipal, "see_deleted", {
                forumId: post.forumId,
                tree,
                snapshot: viewerSnapshot,
              }))));
        const guestAllowed = await can(sql, GUEST_PRINCIPAL, "read", {
          forumId: post.forumId,
          tree,
          snapshot: guestSnapshot,
        });
        const serviceAllowed =
          guestAllowed ||
          plugin.service_principal_group !== "Guests" ||
          grants.includes(post.forumId);

        if (!viewerAllowed || !serviceAllowed) {
          return denied("The viewer and plugin principal may not read this post");
        }

        return Response.json({
          result: {
            id: post.id,
            topicId: post.topicId,
            forumId: post.forumId,
            authorId: post.authorId,
            bodyMd: post.bodyMd,
            bodyHtml: post.bodyHtml,
            createdAt: post.createdAt.toISOString(),
          },
        });
      }

      default:
        return Response.json({ code: "not_implemented" }, { status: 501 });
    }
  } catch {
    return Response.json({ code: "core_failed" }, { status: 500 });
  }
}
