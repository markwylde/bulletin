import type { SQL } from "bun";
import { writeModerationLog } from "../../moderation/log/repository.ts";
import { runMutation } from "../../mutations/index.ts";
import { multimodApplyMutation } from "../../mutations/topics.ts";
import { can } from "../../permissions/can.ts";
import { loadForumTree } from "../../permissions/tree-store.ts";
import { slugify } from "../../urls/index.ts";
import { writeGuardedReply } from "../posting.ts";
import {
  adjustForumPostCount,
  adjustForumTopicCount,
  loadForumTarget,
  loadTopicForWrite,
  lockTopicForWrite,
  moveTopicRow,
  prefixEnabledForForum,
  recountTopic,
  refreshForumLastPost,
  setTopicLocked,
  setTopicPinned,
  visiblePostCount,
} from "../repository.ts";
import { rejectOutcome, type TopicMutationOutcome } from "../result.ts";

export type MultimodStep =
  | { readonly type: "move"; readonly forumId: string }
  | { readonly type: "lock"; readonly locked: boolean }
  | { readonly type: "pin"; readonly pinned: boolean }
  | { readonly type: "prefix"; readonly prefixId: string }
  | {
      readonly type: "title";
      readonly position: "prepend" | "append";
      readonly text: string;
    }
  | { readonly type: "reply"; readonly bodyMd: string; readonly authorId: string | null };

export interface MultimodActionRecord {
  readonly id: string;
  readonly name: string;
  readonly forumIds: readonly string[];
  readonly steps: readonly MultimodStep[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MultimodSummary {
  readonly topicId: string;
  readonly forumIds: readonly string[];
  readonly memberIds: readonly string[];
}

export type MultimodOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "forbidden"
        | "invalid_request"
        | "invalid_step"
        | "duplicate_name";
    };

interface MultimodRowSql {
  readonly id: string;
  readonly name: string;
  readonly forum_ids: readonly string[];
  readonly steps: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value.trim()
    : null;
}

function stepArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 ? value : null;
}

/** Validates and normalises a steps array; DB-backed checks run for forums/prefixes/authors. */
export async function validateMultimodSteps(
  sql: SQL,
  value: unknown,
): Promise<readonly MultimodStep[] | null> {
  const rawSteps = stepArray(value);

  if (rawSteps === null) {
    return null;
  }

  const steps: MultimodStep[] = [];

  for (const raw of rawSteps) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      return null;
    }

    switch (raw.type) {
      case "move": {
        if (typeof raw.forumId !== "string" || !/^\d+$/.test(raw.forumId)) {
          return null;
        }

        const forum = await loadForumTarget(sql, raw.forumId);

        if (forum === null || forum.type !== "forum") {
          return null;
        }

        steps.push({ type: "move", forumId: raw.forumId });
        break;
      }
      case "lock":
        if (typeof raw.locked !== "boolean") {
          return null;
        }
        steps.push({ type: "lock", locked: raw.locked });
        break;
      case "pin":
        if (typeof raw.pinned !== "boolean") {
          return null;
        }
        steps.push({ type: "pin", pinned: raw.pinned });
        break;
      case "prefix": {
        if (typeof raw.prefixId !== "string" || !/^\d+$/.test(raw.prefixId)) {
          return null;
        }

        const [prefix] = (await sql`
          SELECT 1 FROM core.prefixes WHERE id = ${raw.prefixId}
        `) as unknown[];

        if (prefix === undefined) {
          return null;
        }

        steps.push({ type: "prefix", prefixId: raw.prefixId });
        break;
      }
      case "title": {
        const titleText = text(raw.text, 100);

        if (titleText === null || (raw.position !== "prepend" && raw.position !== "append")) {
          return null;
        }

        steps.push({ type: "title", position: raw.position, text: titleText });
        break;
      }
      case "reply": {
        const bodyMd = text(raw.bodyMd, 5_000);

        if (bodyMd === null) {
          return null;
        }

        if (raw.authorId !== null && raw.authorId !== undefined) {
          if (typeof raw.authorId !== "string" || !/^\d+$/.test(raw.authorId)) {
            return null;
          }

          const [service] = (await sql`
            SELECT 1 FROM core.members
            WHERE id = ${raw.authorId} AND is_service = true
          `) as unknown[];

          if (service === undefined) {
            return null;
          }

          steps.push({ type: "reply", bodyMd, authorId: raw.authorId });
        } else {
          steps.push({ type: "reply", bodyMd, authorId: null });
        }
        break;
      }
      default:
        return null;
    }
  }

  return steps;
}

function toRecord(row: MultimodRowSql): MultimodActionRecord {
  return {
    id: row.id,
    name: row.name,
    forumIds: row.forum_ids,
    steps: row.steps as readonly MultimodStep[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMultimodActions(sql: SQL): Promise<readonly MultimodActionRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, name, forum_ids::text[] AS forum_ids, steps, created_at, updated_at
    FROM core.multimod_actions
    ORDER BY name, id
  `) as MultimodRowSql[];

  return rows.map(toRecord);
}

export async function listMultimodForForum(
  sql: SQL,
  forumId: string,
): Promise<readonly MultimodActionRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, name, forum_ids::text[] AS forum_ids, steps, created_at, updated_at
    FROM core.multimod_actions
    WHERE forum_ids @> ARRAY[${forumId}]::bigint[]
    ORDER BY name, id
  `) as MultimodRowSql[];

  return rows.map(toRecord);
}

export async function listServiceMembers(
  sql: SQL,
): Promise<readonly { readonly id: string; readonly name: string | null }[]> {
  const rows = (await sql`
    SELECT id::text AS id, display_name AS name
    FROM core.members
    WHERE is_service = true AND state = 'active'
    ORDER BY display_name, id
  `) as Array<{ id: string; name: string | null }>;

  return rows;
}

export async function saveMultimodAction(
  sql: SQL,
  actorId: string,
  input: unknown,
): Promise<MultimodOutcome<{ readonly id: string }>> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const name = text(input.name, 80);
  const forumIds = Array.isArray(input.forumIds)
    ? [...new Set(input.forumIds.filter((value): value is string => typeof value === "string"))]
    : [];

  if (name === null || forumIds.length === 0) {
    return { ok: false, code: "invalid_request" };
  }

  for (const forumId of forumIds) {
    if (!/^\d+$/.test(forumId)) {
      return { ok: false, code: "invalid_request" };
    }

    const forum = await loadForumTarget(sql, forumId);

    if (forum === null || forum.type !== "forum") {
      return { ok: false, code: "invalid_request" };
    }
  }

  const steps = await validateMultimodSteps(sql, input.steps);

  if (steps === null) {
    return { ok: false, code: "invalid_step" };
  }

  const forumArray = `{${forumIds.join(",")}}`;

  try {
    const result = await sql.begin(async (tx) => {
      if (typeof input.id === "string" && /^\d+$/.test(input.id)) {
        const rows = (await tx`
          UPDATE core.multimod_actions
          SET name = ${name}, forum_ids = ${forumArray}::bigint[],
              steps = (${JSON.stringify(steps)}::text)::jsonb, updated_at = now()
          WHERE id = ${input.id}
          RETURNING id::text AS id
        `) as Array<{ id: string }>;
        return rows[0]?.id ?? null;
      }

      const rows = (await tx`
        INSERT INTO core.multimod_actions (name, forum_ids, steps, created_by)
        VALUES (
          ${name}, ${forumArray}::bigint[],
          (${JSON.stringify(steps)}::text)::jsonb, ${actorId}
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    });

    if (result === null) {
      return { ok: false, code: "not_found" };
    }

    return { ok: true, result: { id: result } };
  } catch (error) {
    if (error instanceof Error && error.message.includes("multimod_actions_name_key")) {
      return { ok: false, code: "duplicate_name" };
    }

    throw error;
  }
}

export async function deleteMultimodAction(
  sql: SQL,
  actionId: string,
): Promise<MultimodOutcome<{ readonly deleted: boolean }>> {
  if (!/^\d+$/.test(actionId)) {
    return { ok: false, code: "not_found" };
  }

  const rows = (await sql`
    DELETE FROM core.multimod_actions WHERE id = ${actionId} RETURNING 1
  `) as unknown[];

  return { ok: true, result: { deleted: rows.length > 0 } };
}

function forumChain(
  tree: Awaited<ReturnType<typeof loadForumTree>>,
  forumId: string,
): readonly string[] {
  return [...tree.ancestors(forumId).map((node) => node.id), forumId];
}

async function logMultimod(
  tx: SQL,
  actorId: string,
  action: MultimodActionRecord,
  topic: { readonly id: string; readonly forumId: string; readonly starterId: string | null },
): Promise<void> {
  await writeModerationLog(tx, {
    actorId,
    action: "multimod.apply",
    targetType: "topic",
    targetId: topic.id,
    forumId: topic.forumId,
    memberId: topic.starterId,
    details: { actionId: action.id, name: action.name, steps: action.steps.length },
  });
}

/**
 * Applies a saved action in one transaction. The action is available only in its chosen
 * forums and only to moderators with the multi-mod power. Reply steps use the acting member
 * unless the definition pinned a service member when it was saved.
 */
export async function applyMultimod(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly actionId: string;
    readonly topicId: string;
    readonly sessionId?: string | null;
  },
): Promise<TopicMutationOutcome<MultimodSummary>> {
  if (!/^\d+$/.test(input.actionId) || !/^\d+$/.test(input.topicId)) {
    return { ok: false, code: "topic_not_found" };
  }

  const actionRows = (await sql`
    SELECT id::text AS id, name, forum_ids::text[] AS forum_ids, steps, created_at, updated_at
    FROM core.multimod_actions WHERE id = ${input.actionId}
  `) as MultimodRowSql[];
  const action = actionRows[0] === undefined ? null : toRecord(actionRows[0]);

  if (action === null) {
    return { ok: false, code: "topic_not_found" };
  }

  const initial = await loadTopicForWrite(sql, input.topicId);

  if (initial === null || initial.movedTo !== null) {
    return { ok: false, code: "topic_not_found" };
  }

  if (!action.forumIds.includes(initial.forumId)) {
    return { ok: false, code: "forbidden" };
  }

  const tree = await loadForumTree(sql);

  if (
    !(await can(sql, input.actorId, "use_multimod", {
      forumId: initial.forumId,
      tree,
      sessionId: input.sessionId ?? null,
    }))
  ) {
    return { ok: false, code: "forbidden" };
  }

  try {
    const result = await runMutation({
      sql,
      mutation: multimodApplyMutation,
      input: { topicId: input.topicId },
      apply: async (tx) => {
        const topic = await lockTopicForWrite(tx, input.topicId);

        if (topic === null) {
          throw new Error("topic_not_found");
        }

        const freshTree = await loadForumTree(tx);

        if (
          !action.forumIds.includes(topic.forumId) ||
          !(await can(tx, input.actorId, "use_multimod", {
            forumId: topic.forumId,
            tree: freshTree,
            sessionId: input.sessionId ?? null,
          }))
        ) {
          throw new Error("forbidden");
        }

        let currentForumId = topic.forumId;
        let currentTitle = topic.title;
        const forumIds = new Set<string>();
        const memberIds: string[] = [];

        for (const step of action.steps) {
          if (step.type === "move") {
            const destination = await loadForumTarget(tx, step.forumId);

            if (destination === null || destination.type !== "forum") {
              throw new Error("invalid_step");
            }

            if (destination.id !== currentForumId) {
              if (
                !(await can(tx, input.actorId, "move", {
                  forumId: currentForumId,
                  tree: freshTree,
                  sessionId: input.sessionId ?? null,
                })) ||
                !(await can(tx, input.actorId, "move", {
                  forumId: destination.id,
                  tree: freshTree,
                  sessionId: input.sessionId ?? null,
                }))
              ) {
                throw new Error("forbidden");
              }

              const postCount = await visiblePostCount(tx, topic.id);
              // A hidden topic stays out of both forums' counters until it is restored.
              const counted = topic.visibility === "visible";

              if (counted) {
                await adjustForumTopicCount(tx, currentForumId, -1);
                await adjustForumPostCount(tx, currentForumId, -postCount);
              }

              await moveTopicRow(tx, topic.id, destination.id);

              if (counted) {
                await adjustForumTopicCount(tx, destination.id, 1);
                await adjustForumPostCount(tx, destination.id, postCount);
              }
              forumIds.add(currentForumId);
              forumIds.add(destination.id);
              currentForumId = destination.id;
              await refreshForumLastPost(tx, topic.forumId, topic.lastPostId);
              await refreshForumLastPost(tx, destination.id);
            }
          } else if (step.type === "lock") {
            await setTopicLocked(tx, topic.id, step.locked);
          } else if (step.type === "pin") {
            await setTopicPinned(tx, topic.id, step.pinned);
          } else if (step.type === "prefix") {
            if (!(await prefixEnabledForForum(tx, currentForumId, step.prefixId))) {
              throw new Error("invalid_step");
            }

            await tx`
              UPDATE core.topics SET prefix_id = ${step.prefixId}, updated_at = now()
              WHERE id = ${topic.id}
            `;
          } else if (step.type === "title") {
            const nextTitle =
              step.position === "prepend"
                ? `${step.text} ${currentTitle}`
                : `${currentTitle} ${step.text}`;
            const trimmed = nextTitle.trim();

            if (trimmed.length < 3 || trimmed.length > 150) {
              throw new Error("invalid_step");
            }

            await tx`
              UPDATE core.topics
              SET title = ${trimmed}, slug = ${slugify(trimmed)}, updated_at = now()
              WHERE id = ${topic.id}
            `;
            currentTitle = trimmed;
          } else {
            const authorId = step.authorId ?? input.actorId;
            memberIds.push(authorId);
            // The same guarded path as a normal reply: suspension/filters/approval apply
            // before the multi-moderation reply becomes visible.
            await writeGuardedReply(tx, {
              actorId: input.actorId,
              authorId,
              topicId: topic.id,
              forumId: currentForumId,
              bodyMd: step.bodyMd,
              tree: freshTree,
              sessionId: input.sessionId ?? null,
              autoFollow: false,
            });
          }
        }

        await recountTopic(tx, topic.id);
        await refreshForumLastPost(tx, currentForumId);
        await logMultimod(tx, input.actorId, action, {
          id: topic.id,
          forumId: currentForumId,
          starterId: topic.starterId,
        });

        forumIds.add(currentForumId);

        return {
          topicId: topic.id,
          forumIds: [
            ...new Set([...forumIds].flatMap((forumId) => forumChain(freshTree, forumId))),
          ],
          memberIds: [...new Set(memberIds)],
        } satisfies MultimodSummary;
      },
    });

    return { ok: true, result };
  } catch (error) {
    const rejected = rejectOutcome(error);

    if (rejected !== null) {
      return rejected;
    }

    if (error instanceof Error && error.message === "topic_not_found") {
      return { ok: false, code: "topic_not_found" };
    }

    if (
      error instanceof Error &&
      (error.message === "invalid_step" || error.message === "forbidden")
    ) {
      return { ok: false, code: "forbidden" };
    }

    throw error;
  }
}
