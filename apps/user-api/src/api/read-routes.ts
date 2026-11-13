import type { ApiPrincipal } from "@bulletin/domain/api";
import { readBoardSettings } from "@bulletin/domain/board";
import { listVisibleForums, readVisibleForum } from "@bulletin/domain/forums";
import { can } from "@bulletin/domain/permissions";
import { readPublicMember } from "@bulletin/domain/profiles";
import { SEARCH_KINDS, SEARCH_SORTS, searchContent } from "@bulletin/domain/search";
import {
  readPostContext,
  readTopic,
  readTopicList,
  readTopicPostById,
  readTopicPostPage,
  type TopicListSort,
  type TopicRecord,
} from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { SQL } from "bun";
import * as v from "valibot";
import { apiLocale, loadApiPermissions, pageNumber, pageSize } from "./permissions.ts";
import { type ApiResponseDefinition, defineApiRoute } from "./route.ts";
import {
  forumJson,
  memberJson,
  postJson,
  preparedPostBodies,
  preparedPostJson,
  searchHitJson,
  topicJson,
  topicListJson,
} from "./serializers.ts";

const DIGITS = /^\d+$/;
const ID_PARAMS = v.object({ id: v.pipe(v.string(), v.regex(DIGITS)) });
const PAGE_QUERY = v.object({
  page: v.optional(v.string()),
  perPage: v.optional(v.string()),
});

const COMMON_ERRORS: Readonly<Record<number, ApiResponseDefinition>> = {
  400: { description: "Invalid request" },
  401: { description: "A valid API key is required" },
  403: { description: "The key lacks the required scope" },
  404: { description: "Not found or not visible to the principal" },
  429: { description: "Rate limited" },
};

function responses(success: ApiResponseDefinition): Record<number, ApiResponseDefinition> {
  return { 200: success, ...COMMON_ERRORS };
}

const forumSchema = v.object({
  id: v.string(),
  parentId: v.nullable(v.string()),
  type: v.string(),
  title: v.string(),
  slug: v.string(),
  url: v.string(),
  description: v.string(),
  passwordProtected: v.boolean(),
  redirectUrl: v.nullable(v.string()),
  topicCount: v.number(),
  postCount: v.number(),
  lastPostId: v.nullable(v.string()),
  lastPostAt: v.nullable(v.string()),
  lastPostMemberName: v.nullable(v.string()),
});

const topicSchema = v.object({
  id: v.string(),
  forumId: v.string(),
  title: v.string(),
  slug: v.string(),
  url: v.string(),
  prefixId: v.nullable(v.string()),
  starterId: v.nullable(v.string()),
  pinned: v.boolean(),
  locked: v.boolean(),
  replyCount: v.number(),
  viewCount: v.number(),
  createdAt: v.string(),
  lastPostId: v.nullable(v.string()),
  lastPostAt: v.nullable(v.string()),
  movedTo: v.nullable(v.string()),
});

const topicRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  slug: v.string(),
  url: v.string(),
  prefixId: v.nullable(v.string()),
  prefix: v.nullable(v.string()),
  prefixColour: v.nullable(v.string()),
  starterId: v.nullable(v.string()),
  starterName: v.nullable(v.string()),
  pinned: v.boolean(),
  locked: v.boolean(),
  movedTo: v.nullable(v.string()),
  replyCount: v.number(),
  viewCount: v.number(),
  lastPostId: v.nullable(v.string()),
  lastPostAt: v.nullable(v.string()),
  lastPostMemberName: v.nullable(v.string()),
});

const postSchema = v.object({
  id: v.string(),
  topicId: v.string(),
  url: v.string(),
  author: v.object({ id: v.nullable(v.string()), name: v.nullable(v.string()) }),
  bodyHtml: v.string(),
  bodyText: v.string(),
  position: v.number(),
  createdAt: v.string(),
  editedAt: v.nullable(v.string()),
  editedByName: v.nullable(v.string()),
});

const memberSchema = v.object({
  id: v.string(),
  displayName: v.nullable(v.string()),
  url: v.string(),
  avatarHash: v.nullable(v.string()),
  joinedAt: v.string(),
  lastActiveAt: v.nullable(v.string()),
  postCount: v.number(),
  reputation: v.number(),
  customTitle: v.nullable(v.string()),
  groupTitle: v.nullable(v.string()),
  groupColour: v.nullable(v.string()),
  rank: v.object({
    title: v.nullable(v.record(v.string(), v.string())),
    pips: v.number(),
    imageKey: v.nullable(v.string()),
  }),
});

const searchHitSchema = v.looseObject({
  kind: v.picklist(["topic", "post"]),
  id: v.string(),
  title: v.string(),
  url: v.string(),
});

function topicVisibility(
  topic: Pick<TopicRecord, "visibility">,
  seeUnapproved: boolean,
  seeDeleted: boolean,
): boolean {
  return (
    topic.visibility === "visible" ||
    (topic.visibility === "unapproved" && seeUnapproved) ||
    (topic.visibility === "soft_deleted" && seeDeleted)
  );
}

interface VisibleTopic {
  readonly topic: TopicRecord;
  readonly seeUnapproved: boolean;
  readonly seeDeleted: boolean;
}

async function readVisibleTopic(
  sql: SQL,
  principal: ApiPrincipal,
  topicId: string,
): Promise<VisibleTopic | null> {
  const permissions = await loadApiPermissions(sql, principal);
  const topic = await readTopic(sql, topicId);

  if (topic === null) {
    return null;
  }

  const scope = {
    forumId: topic.forumId,
    tree: permissions.tree,
    sessionId: null,
    snapshot: permissions.snapshot,
  };

  if (!(await can(sql, permissions.viewer, "read", scope))) {
    return null;
  }

  const seeUnapproved = await can(sql, permissions.viewer, "see_unapproved", scope);
  const seeDeleted = await can(sql, permissions.viewer, "see_deleted", scope);

  if (!topicVisibility(topic, seeUnapproved, seeDeleted)) {
    return null;
  }

  return { topic, seeUnapproved, seeDeleted };
}

async function topicPageResponse(
  sql: SQL,
  principal: ApiPrincipal,
  forumId: string,
  query: {
    readonly page?: string | undefined;
    readonly perPage?: string | undefined;
    readonly sort?: TopicListSort | undefined;
    readonly prefixId?: string | undefined;
  },
): Promise<Response> {
  const permissions = await loadApiPermissions(sql, principal);
  const forum = await readVisibleForum(sql, permissions.capability, forumId);

  if (forum === null) {
    return Response.json({ code: "not_found" }, { status: 404 });
  }

  const settings = await readBoardSettings(sql);
  const locale = await apiLocale(sql, principal, settings.defaultLocale);
  const page = pageNumber(query.page);
  const perPage = pageSize(query.perPage, settings.topicsPerPage);
  const seeUnapproved = permissions.capability.has(forum.id, "see_unapproved");
  const seeDeleted = permissions.capability.has(forum.id, "see_deleted");
  const prefixId =
    query.prefixId !== undefined && DIGITS.test(query.prefixId) ? query.prefixId : null;
  const result = await readTopicList(sql, {
    forumId: forum.id,
    locale,
    sort: query.sort ?? forum.defaultSort,
    prefixId,
    page,
    perPage,
    seeUnapproved,
    seeDeleted,
  });
  const pageCount = Math.max(1, Math.ceil(result.total / perPage));

  return Response.json({
    forum: {
      id: forum.id,
      title: forum.title,
      slug: forum.slug,
      url: canonicalUrl("forum", forum.id, forum.slug),
    },
    topics: result.rows.map(topicListJson),
    page: Math.min(page, pageCount),
    pageSize: perPage,
    total: result.total,
    pageCount,
  });
}

export const FORUM_ROUTES = [
  defineApiRoute({
    method: "GET",
    path: "/api/v1/forums",
    operationId: "listForums",
    summary: "List forums the principal may read",
    tags: ["forums"],
    auth: "optional",
    scopes: ["read:forums"],
    responses: responses({
      description: "Visible forums",
      schema: v.object({ forums: v.array(forumSchema) }),
    }),
    handler: async ({ sql, principal }) => {
      const permissions = await loadApiPermissions(sql, principal);
      const forums = await listVisibleForums(sql, permissions.capability);

      return Response.json({
        forums: forums.filter((forum) => permissions.capability.read(forum.id)).map(forumJson),
      });
    },
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/forums/:id",
    operationId: "getForum",
    summary: "Read one forum",
    tags: ["forums"],
    auth: "optional",
    scopes: ["read:forums"],
    params: ID_PARAMS,
    responses: responses({
      description: "Forum",
      schema: v.object({ forum: forumSchema }),
    }),
    handler: async ({ sql, principal, params }) => {
      const permissions = await loadApiPermissions(sql, principal);
      const forum = await readVisibleForum(sql, permissions.capability, params.id);

      return forum === null
        ? Response.json({ code: "not_found" }, { status: 404 })
        : Response.json({ forum: forumJson(forum) });
    },
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/forums/:id/topics",
    operationId: "listForumTopics",
    summary: "List topics in a forum",
    tags: ["forums", "topics"],
    auth: "optional",
    scopes: ["read:forums", "read:topics"],
    params: ID_PARAMS,
    query: v.object({
      ...PAGE_QUERY.entries,
      sort: v.optional(v.picklist(["last_post", "start_date", "title"])),
      prefixId: v.optional(v.string()),
    }),
    responses: responses({
      description: "Topic page",
      schema: v.object({
        forum: v.object({ id: v.string(), title: v.string(), slug: v.string(), url: v.string() }),
        topics: v.array(topicRowSchema),
        page: v.number(),
        pageSize: v.number(),
        total: v.number(),
        pageCount: v.number(),
      }),
    }),
    handler: async ({ sql, principal, params, query }) =>
      topicPageResponse(sql, principal, params.id, query),
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/topics",
    operationId: "listTopics",
    summary: "List topics in a forum",
    tags: ["topics"],
    auth: "optional",
    scopes: ["read:topics"],
    query: v.object({
      forumId: v.pipe(v.string(), v.regex(DIGITS)),
      ...PAGE_QUERY.entries,
      sort: v.optional(v.picklist(["last_post", "start_date", "title"])),
      prefixId: v.optional(v.string()),
    }),
    responses: responses({
      description: "Topic page",
      schema: v.object({
        forum: v.object({ id: v.string(), title: v.string(), slug: v.string(), url: v.string() }),
        topics: v.array(topicRowSchema),
        page: v.number(),
        pageSize: v.number(),
        total: v.number(),
        pageCount: v.number(),
      }),
    }),
    handler: async ({ sql, principal, query }) =>
      topicPageResponse(sql, principal, query.forumId, query),
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/topics/:id",
    operationId: "getTopic",
    summary: "Read one topic",
    tags: ["topics"],
    auth: "optional",
    scopes: ["read:topics"],
    params: ID_PARAMS,
    responses: responses({
      description: "Topic",
      schema: v.object({ topic: topicSchema }),
    }),
    handler: async ({ sql, principal, params }) => {
      const visible = await readVisibleTopic(sql, principal, params.id);

      return visible === null
        ? Response.json({ code: "not_found" }, { status: 404 })
        : Response.json({ topic: topicJson(visible.topic) });
    },
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/topics/:id/posts",
    operationId: "listTopicPosts",
    summary: "List a topic's posts",
    tags: ["topics", "posts"],
    auth: "optional",
    scopes: ["read:topics", "read:posts"],
    params: ID_PARAMS,
    query: PAGE_QUERY,
    responses: responses({
      description: "Post page",
      schema: v.object({
        topic: v.object({ id: v.string(), title: v.string(), slug: v.string(), url: v.string() }),
        posts: v.array(postSchema),
        page: v.number(),
        pageSize: v.number(),
        total: v.number(),
        pageCount: v.number(),
      }),
    }),
    handler: async ({ sql, principal, params, query }) => {
      const visible = await readVisibleTopic(sql, principal, params.id);

      if (visible === null) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      const settings = await readBoardSettings(sql);
      const page = pageNumber(query.page);
      const perPage = pageSize(query.perPage, settings.postsPerPage);
      const result = await readTopicPostPage(sql, {
        topicId: visible.topic.id,
        limit: perPage,
        offset: (page - 1) * perPage,
        seeUnapproved: visible.seeUnapproved,
        seeDeleted: visible.seeDeleted,
      });
      const pageCount = Math.max(1, Math.ceil(result.total / perPage));
      const bodies = await preparedPostBodies(sql, result.rows);

      return Response.json({
        topic: {
          id: visible.topic.id,
          title: visible.topic.title,
          slug: visible.topic.slug,
          url: canonicalUrl("topic", visible.topic.id, visible.topic.slug),
        },
        posts: result.rows.map((post) => {
          const current = bodies.get(post.id);
          return postJson(
            post,
            visible.topic,
            current?.bodyHtml ?? post.bodyHtml,
            current?.bodyText ?? post.bodyText,
          );
        }),
        page: Math.min(page, pageCount),
        pageSize: perPage,
        total: result.total,
        pageCount,
      });
    },
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/posts/:id",
    operationId: "getPost",
    summary: "Read one post",
    tags: ["posts"],
    auth: "optional",
    scopes: ["read:posts"],
    params: ID_PARAMS,
    responses: responses({
      description: "Post",
      schema: v.object({ post: postSchema }),
    }),
    handler: async ({ sql, principal, params }) => {
      const context = await readPostContext(sql, params.id);

      if (context === null) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      // The topic is the parent resource: a hidden topic hides every post it contains, even
      // when the post row itself is still `visible`.
      const visible = await readVisibleTopic(sql, principal, context.topicId);

      if (visible === null) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      if (
        !topicVisibility(
          { visibility: context.visibility },
          visible.seeUnapproved,
          visible.seeDeleted,
        )
      ) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      const post = await readTopicPostById(sql, {
        topicId: context.topicId,
        postId: params.id,
        seeUnapproved: visible.seeUnapproved,
        seeDeleted: visible.seeDeleted,
      });

      if (post === null) {
        return Response.json({ code: "not_found" }, { status: 404 });
      }

      return Response.json({ post: await preparedPostJson(sql, post, visible.topic) });
    },
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/members/:id",
    operationId: "getMember",
    summary: "Read a member's public fields",
    tags: ["members"],
    auth: "optional",
    scopes: ["read:members"],
    params: ID_PARAMS,
    responses: responses({
      description: "Public member fields",
      schema: v.object({ member: memberSchema }),
    }),
    handler: async ({ sql, params }) => {
      const member = await readPublicMember(sql, params.id);

      return member === null
        ? Response.json({ code: "not_found" }, { status: 404 })
        : Response.json({ member: memberJson(member) });
    },
  }),

  defineApiRoute({
    method: "GET",
    path: "/api/v1/search",
    operationId: "searchContent",
    summary: "Search readable topics and posts",
    tags: ["search"],
    auth: "optional",
    scopes: ["read:search"],
    query: v.object({
      q: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
      kind: v.optional(v.picklist([...SEARCH_KINDS])),
      sort: v.optional(v.picklist([...SEARCH_SORTS])),
      forumId: v.optional(v.pipe(v.string(), v.regex(DIGITS))),
      authorId: v.optional(v.pipe(v.string(), v.regex(DIGITS))),
      createdFrom: v.optional(v.string()),
      createdTo: v.optional(v.string()),
      ...PAGE_QUERY.entries,
    }),
    responses: responses({
      description: "Search page",
      schema: v.object({
        items: v.array(searchHitSchema),
        page: v.number(),
        pageSize: v.number(),
        total: v.number(),
        pageCount: v.number(),
        capped: v.boolean(),
      }),
    }),
    handler: async ({ sql, principal, query }) => {
      const createdFrom = parseDate(query.createdFrom, "createdFrom");
      const createdTo = parseDate(query.createdTo, "createdTo");

      if (!createdFrom.ok || !createdTo.ok) {
        return Response.json({ code: "validation_failed" }, { status: 400 });
      }

      const permissions = await loadApiPermissions(sql, principal);
      const settings = await readBoardSettings(sql);
      const locale = await apiLocale(sql, principal, settings.defaultLocale);
      const result = await searchContent(
        sql,
        { capability: permissions.capability, locale },
        {
          query: query.q,
          kind: query.kind ?? "posts",
          sort: query.sort ?? "relevance",
          page: pageNumber(query.page),
          perPage: pageSize(query.perPage, 20),
          forumIds: query.forumId === undefined ? null : [query.forumId],
          authorId: query.authorId ?? null,
          createdFrom: createdFrom.value,
          createdTo: createdTo.value,
        },
      );

      return Response.json({
        items: result.items.map(searchHitJson),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        pageCount: result.pageCount,
        capped: result.capped,
      });
    },
  }),
] as const;

type DateResult = { readonly ok: true; readonly value: Date | null } | { readonly ok: false };

function parseDate(value: string | undefined, _field: string): DateResult {
  if (value === undefined || value === "") {
    return { ok: true, value: null };
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? { ok: false } : { ok: true, value: parsed };
}
