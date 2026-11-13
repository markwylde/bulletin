import { isApiKeyPrincipal } from "@bulletin/domain/api";
import { follow, unfollow } from "@bulletin/domain/follows";
import * as v from "valibot";
import { createUserApiFlags } from "../flag-guard.ts";
import { blockedPostingResponse } from "../posting-guard.ts";
import { reactionSetResponse } from "../reactions.ts";
import { createTopicResponse, replyResponse } from "../topics.ts";
import { type ApiResponseDefinition, defineApiRoute } from "./route.ts";

const DIGITS = /^\d+$/;
const ID_PARAMS = v.object({ id: v.pipe(v.string(), v.regex(DIGITS)) });

const COMMON_ERRORS: Readonly<Record<number, ApiResponseDefinition>> = {
  400: { description: "Invalid request" },
  401: { description: "A valid API key is required" },
  403: { description: "The key lacks the required scope or the principal may not do this" },
  404: { description: "Not found or not visible to the principal" },
  409: { description: "Conflict, such as a locked topic" },
  422: { description: "Rejected by a plugin" },
  429: { description: "Rate limited or flood control" },
};

function responses(success: ApiResponseDefinition): Record<number, ApiResponseDefinition> {
  return { 200: success, ...COMMON_ERRORS };
}

const writeResultSchema = v.object({
  ok: v.boolean(),
  topicId: v.string(),
  postId: v.string(),
  url: v.union([v.string(), v.null()]),
});

/** The reaction bar state after a write: the viewer's own reaction and the per-reaction totals. */
const reactionStateSchema = v.object({
  ok: v.boolean(),
  postId: v.string(),
  mine: v.nullable(v.string()),
  summary: v.record(v.string(), v.number()),
});

export const WRITE_ROUTES = [
  defineApiRoute({
    method: "POST",
    path: "/api/v1/forums/:id/topics",
    operationId: "createTopic",
    summary: "Create a topic",
    tags: ["topics"],
    auth: "required",
    scopes: ["write:posts"],
    params: ID_PARAMS,
    body: v.object({
      title: v.pipe(v.string(), v.minLength(1)),
      bodyMd: v.pipe(v.string(), v.minLength(1)),
      prefixId: v.optional(v.string()),
      poll: v.optional(v.unknown()),
    }),
    responses: responses({ description: "Created topic", schema: writeResultSchema }),
    handler: async ({ sql, principal, params, request }) => {
      if (!isApiKeyPrincipal(principal)) {
        return Response.json({ code: "unauthenticated" }, { status: 401 });
      }

      const blocked = await blockedPostingResponse(sql, request);

      if (blocked !== null) {
        return blocked;
      }

      const flags = createUserApiFlags(sql);
      const [pollsEnabled, followsEnabled] = await Promise.all([
        flags.enabled("polls", principal.memberId),
        flags.enabled("follows", principal.memberId),
      ]);

      return createTopicResponse(sql, { memberId: principal.memberId }, params.id, request, {
        pollsEnabled,
        followsEnabled,
      });
    },
  }),

  defineApiRoute({
    method: "POST",
    path: "/api/v1/topics/:id/replies",
    operationId: "replyToTopic",
    summary: "Reply to a topic",
    tags: ["topics", "posts"],
    auth: "required",
    scopes: ["write:posts"],
    params: ID_PARAMS,
    body: v.object({ bodyMd: v.pipe(v.string(), v.minLength(1)) }),
    responses: responses({ description: "Created reply", schema: writeResultSchema }),
    handler: async ({ sql, principal, params, request }) => {
      if (!isApiKeyPrincipal(principal)) {
        return Response.json({ code: "unauthenticated" }, { status: 401 });
      }

      const blocked = await blockedPostingResponse(sql, request);

      if (blocked !== null) {
        return blocked;
      }

      const flags = createUserApiFlags(sql);
      const followsEnabled = await flags.enabled("follows", principal.memberId);

      return replyResponse(sql, { memberId: principal.memberId }, params.id, request, {
        followsEnabled,
      });
    },
  }),

  defineApiRoute({
    method: "POST",
    path: "/api/v1/posts/:id/reactions",
    operationId: "reactToPost",
    summary: "Add or remove a reaction",
    tags: ["posts", "reactions"],
    auth: "required",
    scopes: ["write:reactions"],
    params: ID_PARAMS,
    body: v.object({
      reactionId: v.nullable(v.pipe(v.string(), v.regex(DIGITS))),
    }),
    responses: responses({
      description: "Reaction state",
      schema: reactionStateSchema,
    }),
    handler: async ({ sql, principal, params, request }) => {
      if (!isApiKeyPrincipal(principal)) {
        return Response.json({ code: "unauthenticated" }, { status: 401 });
      }

      const flags = createUserApiFlags(sql);

      if (!(await flags.enabled("reactions", principal.memberId))) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      return reactionSetResponse(sql, { memberId: principal.memberId }, params.id, request);
    },
  }),

  defineApiRoute({
    method: "POST",
    path: "/api/v1/follows",
    operationId: "setFollow",
    summary: "Follow or unfollow a topic, forum or member",
    tags: ["follows"],
    auth: "required",
    scopes: ["write:follows"],
    body: v.object({
      kind: v.picklist(["topic", "forum", "member"]),
      id: v.pipe(v.string(), v.regex(DIGITS)),
      following: v.boolean(),
    }),
    responses: responses({
      description: "Follow state",
      schema: v.object({ ok: v.boolean(), following: v.boolean() }),
    }),
    handler: async ({ sql, principal, body }) => {
      if (!isApiKeyPrincipal(principal)) {
        return Response.json({ code: "unauthenticated" }, { status: 401 });
      }

      const flags = createUserApiFlags(sql);

      if (!(await flags.enabled("follows", principal.memberId))) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      if (body.following) {
        const outcome = await follow(sql, {
          memberId: principal.memberId,
          kind: body.kind,
          id: body.id,
          sessionId: null,
        });

        if (!outcome.ok) {
          return outcome.code === "not_found"
            ? Response.json({ code: "not_found" }, { status: 404 })
            : Response.json({ code: "cannot_follow_self" }, { status: 400 });
        }
      } else {
        await unfollow(sql, {
          memberId: principal.memberId,
          kind: body.kind,
          id: body.id,
        });
      }

      return Response.json({ ok: true, following: body.following });
    },
  }),
] as const;
