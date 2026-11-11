import { saveContent } from "@bulletin/content";
import { forumSettingsMutation, forumTreeMutation, runMutation } from "@bulletin/domain/mutations";
import { bumpPermVersion, hashForumPassword, loadForumTree } from "@bulletin/domain/permissions";
import {
  listForumReputationReceivers,
  recountReputationReceivers,
} from "@bulletin/domain/reputation";
import { slugify } from "@bulletin/domain/urls";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";
import { loadStaffContentRenderOptions } from "./content-dependencies.ts";

export type ForumType = "category" | "forum" | "redirect";
export type ForumDefaultSort = "last_post" | "start_date" | "title";
export type ForumPrefixMode = "none" | "optional" | "required";

export interface ForumAdminRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly position: number;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly rules: string;
  readonly passwordProtected: boolean;
  readonly showModerators: boolean;
  readonly language: string | null;
  readonly defaultSort: ForumDefaultSort;
  readonly prefixMode: ForumPrefixMode;
  readonly redirectUrl: string | null;
  readonly redirectClicks: number;
  readonly topicCount: number;
  readonly postCount: number;
  readonly prefixIds: readonly string[];
}

export type ForumMutationCode =
  | "invalid_request"
  | "invalid_title"
  | "invalid_type"
  | "invalid_parent"
  | "invalid_redirect"
  | "invalid_cycle"
  | "invalid_position"
  | "invalid_settings"
  | "invalid_language"
  | "invalid_prefix"
  | "prefix_required_needs_prefix"
  | "topic_choice_required"
  | "invalid_topic_choice"
  | "not_found";

export type ForumMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ForumMutationCode };

interface ForumRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly position: number;
  readonly type: ForumType;
  readonly title: string;
  readonly slug: string;
  readonly description: string;
  readonly rules: string;
  readonly password_protected: boolean;
  readonly show_moderators: boolean;
  readonly language: string | null;
  readonly default_sort: ForumDefaultSort;
  readonly prefix_mode: ForumPrefixMode;
  readonly redirect_url: string | null;
  readonly redirect_clicks: string;
  readonly topic_count: number;
  readonly post_count: number;
  readonly prefix_ids: readonly string[];
}

const FORUM_TYPES: readonly ForumType[] = ["category", "forum", "redirect"];
const DEFAULT_SORTS: readonly ForumDefaultSort[] = ["last_post", "start_date", "title"];
const PREFIX_MODES: readonly ForumPrefixMode[] = ["none", "optional", "required"];
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;
const MAX_TEXT = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string" || value.length > max) {
    return null;
  }

  return value;
}

function validTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const title = value.trim();
  return title.length > 0 && title.length <= 120 ? title : null;
}

function validRedirect(value: unknown): string | null {
  if (typeof value !== "string" || !/^https?:\/\//.test(value.trim())) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function optionalParent(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}

function positionValue(value: unknown, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }

  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export async function listForumsAdmin(
  sql: SQL,
): Promise<{ readonly forums: readonly ForumAdminRecord[] }> {
  const rows = (await sql`
    SELECT
      f.id, f.parent_id, f.position, f.type, f.title, f.slug, f.description, f.rules,
      (f.password_hash IS NOT NULL) AS password_protected, f.show_moderators, f.language,
      f.default_sort, f.prefix_mode, f.redirect_url, f.redirect_clicks::text AS redirect_clicks,
      f.topic_count, f.post_count,
      ARRAY(
        SELECT fp.prefix_id::text FROM core.forum_prefixes fp
        WHERE fp.forum_id = f.id ORDER BY fp.position, fp.prefix_id
      ) AS prefix_ids
    FROM core.forums f
    ORDER BY f.path, f.position, f.id
  `) as ForumRow[];

  return {
    forums: rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      position: row.position,
      type: row.type,
      title: row.title,
      slug: row.slug,
      description: row.description,
      rules: row.rules,
      passwordProtected: row.password_protected,
      showModerators: row.show_moderators,
      language: row.language,
      defaultSort: row.default_sort,
      prefixMode: row.prefix_mode,
      redirectUrl: row.redirect_url,
      redirectClicks: Number(row.redirect_clicks),
      topicCount: row.topic_count,
      postCount: row.post_count,
      prefixIds: row.prefix_ids,
    })),
  };
}

async function resequence(tx: SQL, parentId: string | null): Promise<void> {
  const siblings = (await tx`
    SELECT id FROM core.forums
    WHERE parent_id IS NOT DISTINCT FROM ${parentId}
    ORDER BY position, id
  `) as Array<{ id: string }>;

  for (const [index, sibling] of siblings.entries()) {
    await tx`UPDATE core.forums SET position = ${index} WHERE id = ${sibling.id}`;
  }
}

function affectedIds(
  tree: Awaited<ReturnType<typeof loadForumTree>>,
  forumId: string,
  otherParent: string | null = null,
): readonly string[] {
  const ids = new Set<string>([forumId]);

  for (const node of tree.ancestors(forumId)) {
    ids.add(node.id);
  }

  for (const node of tree.descendants(forumId)) {
    ids.add(node.id);
  }

  if (otherParent !== null) {
    ids.add(otherParent);

    for (const node of tree.ancestors(otherParent)) {
      ids.add(node.id);
    }
  }

  return [...ids];
}

export async function createForum(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<ForumMutation> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const title = validTitle(input.title);
  const type = typeof input.type === "string" ? input.type : "forum";
  const parentId = optionalParent(input.parentId);

  if (title === null) {
    return { ok: false, code: "invalid_title" };
  }

  if (!FORUM_TYPES.includes(type as ForumType)) {
    return { ok: false, code: "invalid_type" };
  }

  if (parentId === undefined) {
    return { ok: false, code: "invalid_parent" };
  }

  const redirectUrl = type === "redirect" ? validRedirect(input.redirectUrl) : null;

  if (type === "redirect" && redirectUrl === null) {
    return { ok: false, code: "invalid_redirect" };
  }

  const tree = await loadForumTree(sql);

  if (parentId !== null) {
    const parent = tree.get(parentId);

    if (parent === undefined || parent.id === "0") {
      return { ok: false, code: "invalid_parent" };
    }

    if (
      (await sql`SELECT type FROM core.forums WHERE id = ${parentId}`).some(
        (row: { type: string }) => row.type === "redirect",
      )
    ) {
      return { ok: false, code: "invalid_parent" };
    }
  }

  const affected = [
    ...(parentId === null ? [] : [parentId]),
    ...(parentId === null ? [] : tree.ancestors(parentId).map((node) => node.id)),
  ];

  await runMutation({
    sql,
    mutation: forumTreeMutation,
    input: { affectedForumIds: affected },
    apply: async (tx) => {
      const [position] = (await tx`
        SELECT coalesce(max(position) + 1, 0)::int AS position
        FROM core.forums
        WHERE parent_id IS NOT DISTINCT FROM ${parentId}
      `) as Array<{ position: number }>;
      const [forum] = (await tx`
        INSERT INTO core.forums (
          parent_id, type, title, slug, redirect_url, position
        )
        VALUES (
          ${parentId}, ${type}, ${title}, ${slugify(title)},
          ${redirectUrl}, ${position?.position ?? 0}
        )
        RETURNING id
      `) as Array<{ id: string }>;

      if (forum === undefined) {
        throw new Error("Forum insert returned no row");
      }

      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "forum.create",
        targetType: "forum",
        targetId: forum.id,
        summary: { title, type, parentId },
      });

      return {};
    },
  });

  return { ok: true };
}

export async function moveForum(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<ForumMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const forumId = input.id;
  const parentId = optionalParent(input.parentId);

  if (parentId === undefined) {
    return { ok: false, code: "invalid_parent" };
  }

  const tree = await loadForumTree(sql);
  const forum = tree.get(forumId);

  if (forum === undefined) {
    return { ok: false, code: "not_found" };
  }

  if (
    parentId === forumId ||
    (parentId !== null && tree.descendants(forumId).some((node) => node.id === parentId))
  ) {
    return { ok: false, code: "invalid_cycle" };
  }

  if (parentId !== null) {
    const parent = tree.get(parentId);

    if (parent === undefined) {
      return { ok: false, code: "invalid_parent" };
    }

    const [row] = (await sql`SELECT type FROM core.forums WHERE id = ${parentId}`) as Array<{
      type: string;
    }>;

    if (row?.type === "redirect") {
      return { ok: false, code: "invalid_parent" };
    }
  }

  const siblings = (await sql`
    SELECT id FROM core.forums
    WHERE parent_id IS NOT DISTINCT FROM ${parentId}
    ORDER BY position, id
  `) as Array<{ id: string }>;
  const position = positionValue(input.position, siblings.length);

  if (position === null) {
    return { ok: false, code: "invalid_position" };
  }

  const affected = affectedIds(tree, forumId, forum.parentId);

  await runMutation({
    sql,
    mutation: forumTreeMutation,
    input: { affectedForumIds: affected },
    apply: async (tx) => {
      const before = forum.parentId;
      await tx`UPDATE core.forums SET parent_id = ${parentId} WHERE id = ${forumId}`;

      const ordered = (await tx`
        SELECT id FROM core.forums
        WHERE parent_id IS NOT DISTINCT FROM ${parentId} AND id <> ${forumId}
        ORDER BY position, id
      `) as Array<{ id: string }>;
      const index = Math.min(position, ordered.length);
      ordered.splice(index, 0, { id: forumId });

      for (const [order, sibling] of ordered.entries()) {
        await tx`UPDATE core.forums SET position = ${order} WHERE id = ${sibling.id}`;
      }

      if (before !== parentId) {
        await resequence(tx, before);
      }

      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "forum.tree.move",
        targetType: "forum",
        targetId: forumId,
        summary: { from: before, to: parentId, position },
      });

      return {};
    },
  });

  return { ok: true };
}

export async function deleteForum(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<ForumMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const forumId = input.id;
  const tree = await loadForumTree(sql);
  const forum = tree.get(forumId);

  if (forum === undefined) {
    return { ok: false, code: "not_found" };
  }

  const [row] = (await sql`
    SELECT parent_id, topic_count FROM core.forums WHERE id = ${forumId}
  `) as Array<{ parent_id: string | null; topic_count: number }>;

  if (row === undefined) {
    return { ok: false, code: "not_found" };
  }

  const topicCount = row.topic_count;
  const topicAction = input.topicAction;
  const moveToForumId =
    typeof input.moveToForumId === "string" && input.moveToForumId !== ""
      ? input.moveToForumId
      : null;

  if (topicCount > 0) {
    if (topicAction !== "move" && topicAction !== "delete") {
      return { ok: false, code: "topic_choice_required" };
    }

    if (topicAction === "move") {
      if (
        moveToForumId === null ||
        moveToForumId === forumId ||
        tree.get(moveToForumId) === undefined ||
        tree.descendants(forumId).some((node) => node.id === moveToForumId)
      ) {
        return { ok: false, code: "invalid_topic_choice" };
      }
    }
  }

  const affected = [
    ...affectedIds(tree, forumId, row.parent_id),
    ...(moveToForumId === null ? [] : affectedIds(tree, moveToForumId)),
  ];

  await runMutation({
    sql,
    mutation: forumTreeMutation,
    input: { affectedForumIds: [...new Set(affected)] },
    apply: async (tx) => {
      const before = (await tx`
        SELECT parent_id, title FROM core.forums WHERE id = ${forumId} FOR UPDATE
      `) as Array<{ parent_id: string | null; title: string }>;

      if (before[0] === undefined) {
        throw new Error("Forum disappeared during deletion");
      }

      let affectedMemberIds: readonly string[] = [];

      // Sub-forums move up one level and keep their settings.
      await tx`
        UPDATE core.forums SET parent_id = ${before[0].parent_id} WHERE parent_id = ${forumId}
      `;

      if (topicAction === "move" && moveToForumId !== null) {
        const [counts] = (await tx`
          SELECT
            count(*) FILTER (WHERE moved_to IS NULL)::int AS topics,
            (
              SELECT count(*)::int
              FROM core.posts p
              JOIN core.topics t ON t.id = p.topic_id
              WHERE t.forum_id = ${forumId} AND p.visibility = 'visible'
            ) AS posts
          FROM core.topics
          WHERE forum_id = ${forumId}
        `) as Array<{ topics: number; posts: number }>;

        await tx`UPDATE core.topics SET forum_id = ${moveToForumId} WHERE forum_id = ${forumId}`;
        await tx`
          UPDATE core.forums
          SET topic_count = topic_count + ${counts?.topics ?? 0},
              post_count = post_count + ${counts?.posts ?? 0},
              updated_at = now()
          WHERE id = ${moveToForumId}
        `;
        await tx`
          UPDATE core.forums f
          SET last_topic_id = (
                SELECT t.id FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
                WHERE t.forum_id = f.id AND p.visibility = 'visible'
                ORDER BY p.created_at DESC, p.id DESC LIMIT 1
              ),
              last_post_id = (
                SELECT p.id FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
                WHERE t.forum_id = f.id AND p.visibility = 'visible'
                ORDER BY p.created_at DESC, p.id DESC LIMIT 1
              ),
              last_post_member_id = (
                SELECT p.author_id FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
                WHERE t.forum_id = f.id AND p.visibility = 'visible'
                ORDER BY p.created_at DESC, p.id DESC LIMIT 1
              ),
              last_post_at = (
                SELECT p.created_at FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
                WHERE t.forum_id = f.id AND p.visibility = 'visible'
                ORDER BY p.created_at DESC, p.id DESC LIMIT 1
              )
          WHERE f.id = ${moveToForumId}
        `;
      } else if (topicAction === "delete") {
        const authors = (await tx`
          SELECT p.author_id::text AS author_id, count(*)::int AS count
          FROM core.posts p
          JOIN core.topics t ON t.id = p.topic_id
          WHERE t.forum_id = ${forumId} AND p.visibility = 'visible' AND p.author_id IS NOT NULL
          GROUP BY p.author_id
        `) as Array<{ author_id: string; count: number }>;
        const reputationReceivers = await listForumReputationReceivers(tx, forumId);

        await tx`DELETE FROM core.topics WHERE forum_id = ${forumId}`;
        await recountReputationReceivers(tx, reputationReceivers);

        for (const author of authors) {
          await tx`
            UPDATE core.members SET post_count = GREATEST(0, post_count - ${author.count})
            WHERE id = ${author.author_id}
          `;
        }

        affectedMemberIds = authors.map((author) => author.author_id);
      }

      await tx`DELETE FROM core.forums WHERE id = ${forumId}`;
      await resequence(tx, before[0].parent_id);

      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "forum.delete",
        targetType: "forum",
        targetId: forumId,
        summary: {
          title: before[0].title,
          movedSubforums: tree.descendants(forumId).length,
          topicCount,
          topicAction: topicAction ?? null,
          moveToForumId,
        },
      });

      return { affectedMemberIds };
    },
  });

  return { ok: true };
}

export async function saveForumSettings(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<ForumMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const forumId = input.id;
  const tree = await loadForumTree(sql);
  const forum = tree.get(forumId);

  if (forum === undefined) {
    return { ok: false, code: "not_found" };
  }

  const [existing] = (await sql`
    SELECT title, description, rules, show_moderators, language, default_sort, prefix_mode,
           redirect_url, type
    FROM core.forums WHERE id = ${forumId}
  `) as Array<{
    title: string;
    description: string;
    rules: string;
    show_moderators: boolean;
    language: string | null;
    default_sort: ForumDefaultSort;
    prefix_mode: ForumPrefixMode;
    redirect_url: string | null;
    type: ForumType;
  }>;

  if (existing === undefined) {
    return { ok: false, code: "not_found" };
  }

  const title = input.title === undefined ? existing.title : validTitle(input.title);
  const description =
    input.description === undefined ? existing.description : textValue(input.description);
  const rules = input.rules === undefined ? existing.rules : textValue(input.rules);

  if (title === null || description === null || rules === null) {
    return { ok: false, code: title === null ? "invalid_title" : "invalid_settings" };
  }

  const showModerators =
    input.showModerators === undefined ? existing.show_moderators : input.showModerators === true;

  const languageInput = input.language === undefined ? existing.language : input.language;
  const language =
    languageInput === null || languageInput === ""
      ? null
      : typeof languageInput === "string" && LANGUAGE.test(languageInput)
        ? languageInput
        : undefined;

  if (language === undefined) {
    return { ok: false, code: "invalid_language" };
  }

  const defaultSort =
    input.defaultSort === undefined
      ? existing.default_sort
      : (input.defaultSort as ForumDefaultSort);

  if (!DEFAULT_SORTS.includes(defaultSort)) {
    return { ok: false, code: "invalid_settings" };
  }

  const prefixMode =
    input.prefixMode === undefined ? existing.prefix_mode : (input.prefixMode as ForumPrefixMode);

  if (!PREFIX_MODES.includes(prefixMode)) {
    return { ok: false, code: "invalid_settings" };
  }

  const prefixIds = Array.isArray(input.prefixIds)
    ? [...new Set(input.prefixIds.filter((value): value is string => typeof value === "string"))]
    : null;

  if (prefixIds === null) {
    return { ok: false, code: "invalid_prefix" };
  }

  if (prefixIds.length > 0) {
    const found = (await sql`
      SELECT id FROM core.prefixes WHERE id = ANY(${`{${prefixIds.join(",")}}`}::bigint[])
    `) as Array<{ id: string }>;

    if (found.length !== prefixIds.length) {
      return { ok: false, code: "invalid_prefix" };
    }
  }

  if (prefixMode === "required" && prefixIds.length === 0) {
    return { ok: false, code: "prefix_required_needs_prefix" };
  }

  const redirectUrl =
    existing.type === "redirect"
      ? input.redirectUrl === undefined
        ? existing.redirect_url
        : validRedirect(input.redirectUrl)
      : null;

  if (existing.type === "redirect" && redirectUrl === null) {
    return { ok: false, code: "invalid_redirect" };
  }

  const password =
    input.clearPassword === true
      ? null
      : typeof input.password === "string" && input.password !== ""
        ? await hashForumPassword(input.password)
        : undefined;

  const renderedRules = await saveContent(rules, {
    profile: "rules",
    context: { kind: "forum_post", forumId },
    authorId: actorMemberId,
    ...(await loadStaffContentRenderOptions(sql, actorMemberId)),
  });
  const affected = affectedIds(tree, forumId, forum.parentId);

  await runMutation({
    sql,
    mutation: forumSettingsMutation,
    input: { affectedForumIds: affected },
    apply: async (tx) => {
      await tx`
        UPDATE core.forums
        SET title = ${title},
            slug = ${slugify(title)},
            description = ${description},
            rules = ${renderedRules.bodyMd},
            rules_html = ${renderedRules.bodyHtml},
            rules_text = ${renderedRules.bodyText},
            rules_render_version = ${renderedRules.renderVersion},
            rules_sanitiser_version = ${renderedRules.sanitiserVersion},
            show_moderators = ${showModerators},
            language = ${language},
            default_sort = ${defaultSort},
            prefix_mode = ${prefixMode},
            redirect_url = ${redirectUrl},
            password_hash = CASE WHEN ${password}::text IS NULL THEN password_hash ELSE ${password} END
        WHERE id = ${forumId}
      `;

      if (input.clearPassword === true) {
        await tx`UPDATE core.forums SET password_hash = NULL WHERE id = ${forumId}`;
      }

      await tx`DELETE FROM core.forum_prefixes WHERE forum_id = ${forumId}`;

      for (const [position, prefixId] of prefixIds.entries()) {
        await tx`
          INSERT INTO core.forum_prefixes (forum_id, prefix_id, position)
          VALUES (${forumId}, ${prefixId}, ${position})
        `;
      }

      await bumpPermVersion(tx);
      await writeAdminLog(tx, {
        actorMemberId,
        action: "forum.settings.update",
        targetType: "forum",
        targetId: forumId,
        summary: {
          title,
          description,
          showModerators,
          language,
          defaultSort,
          prefixMode,
          prefixes: prefixIds,
          passwordChanged: input.clearPassword === true || typeof input.password === "string",
        },
      });
    },
  });

  return { ok: true };
}
