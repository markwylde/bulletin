import { saveContent } from "@bulletin/content";
import { announcementMutation, runMutation } from "@bulletin/domain/mutations";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";
import { loadStaffContentRenderOptions } from "./content-dependencies.ts";

export type AnnouncementScope = "global" | "forums";

export interface AnnouncementTargetInput {
  readonly forumId: string;
  readonly includeSubforums: boolean;
}

export interface AnnouncementAdminRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly scope: AnnouncementScope;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly dismissible: boolean;
  readonly version: number;
  readonly targets: readonly AnnouncementTargetInput[];
  readonly groupIds: readonly string[];
}

export type AnnouncementMutationCode =
  | "invalid_request"
  | "invalid_title"
  | "invalid_body"
  | "invalid_scope"
  | "invalid_schedule"
  | "invalid_target"
  | "invalid_group"
  | "not_found";

export type AnnouncementMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AnnouncementMutationCode };

interface AnnouncementRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly scope: AnnouncementScope;
  readonly starts_at: Date;
  readonly ends_at: Date | null;
  readonly dismissible: boolean;
  readonly version: number;
}

interface TargetRow {
  readonly announcement_id: string;
  readonly forum_id: string;
  readonly include_subforums: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTargets(value: unknown): readonly AnnouncementTargetInput[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const targets = new Map<string, AnnouncementTargetInput>();

  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.forumId !== "string" || !/^\d+$/.test(entry.forumId)) {
      return null;
    }

    targets.set(entry.forumId, {
      forumId: entry.forumId,
      includeSubforums: entry.includeSubforums === true,
    });
  }

  return [...targets.values()];
}

async function targetsFor(
  sql: SQL,
  announcementIds: readonly string[],
): Promise<readonly TargetRow[]> {
  if (announcementIds.length === 0) {
    return [];
  }

  return (await sql`
    SELECT announcement_id, forum_id, include_subforums
    FROM core.announcement_targets
    WHERE announcement_id = ANY(${`{${announcementIds.join(",")}}`}::bigint[])
  `) as TargetRow[];
}

async function groupsFor(
  sql: SQL,
  announcementIds: readonly string[],
): Promise<
  readonly {
    readonly announcement_id: string;
    readonly group_id: string;
  }[]
> {
  if (announcementIds.length === 0) {
    return [];
  }

  return (await sql`
    SELECT announcement_id, group_id
    FROM core.announcement_groups
    WHERE announcement_id = ANY(${`{${announcementIds.join(",")}}`}::bigint[])
  `) as Array<{ announcement_id: string; group_id: string }>;
}

export async function listAnnouncementsAdmin(sql: SQL): Promise<{
  readonly announcements: readonly AnnouncementAdminRecord[];
  readonly forums: ReadonlyArray<{ id: string; parentId: string | null; title: string }>;
  readonly groups: ReadonlyArray<{ id: string; key: string; title: string }>;
}> {
  const rows = (await sql`
    SELECT id, title, body, scope, starts_at, ends_at, dismissible, version
    FROM core.announcements
    ORDER BY starts_at DESC, id DESC
  `) as AnnouncementRow[];
  const ids = rows.map((row) => row.id);
  const targets = await targetsFor(sql, ids);
  const groups = await groupsFor(sql, ids);
  const forums = (await sql`
    SELECT id, parent_id, title FROM core.forums ORDER BY path, position, id
  `) as Array<{ id: string; parent_id: string | null; title: string }>;
  const groupRows = (await sql`
    SELECT id, key, title FROM core.groups ORDER BY display_order, id
  `) as Array<{ id: string; key: string; title: string }>;

  return {
    announcements: rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      scope: row.scope,
      startsAt: new Date(row.starts_at).toISOString(),
      endsAt: row.ends_at === null ? null : new Date(row.ends_at).toISOString(),
      dismissible: row.dismissible,
      version: row.version,
      targets: targets
        .filter((target) => target.announcement_id === row.id)
        .map((target) => ({
          forumId: target.forum_id,
          includeSubforums: target.include_subforums,
        })),
      groupIds: groups
        .filter((group) => group.announcement_id === row.id)
        .map((group) => group.group_id),
    })),
    forums: forums.map((forum) => ({
      id: forum.id,
      parentId: forum.parent_id,
      title: forum.title,
    })),
    groups: groupRows,
  };
}

async function expandForumIds(
  sql: SQL,
  targets: readonly AnnouncementTargetInput[],
): Promise<readonly string[]> {
  const ids = new Set<string>();

  for (const target of targets) {
    if (!target.includeSubforums) {
      ids.add(target.forumId);
      continue;
    }

    const rows = (await sql`
      SELECT id::text AS id FROM core.forums
      WHERE path <@ (SELECT path FROM core.forums WHERE id = ${target.forumId})
    `) as Array<{ id: string }>;

    for (const row of rows) {
      ids.add(row.id);
    }
  }

  return [...ids];
}

export async function saveAnnouncement(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<AnnouncementMutation> {
  if (!isRecord(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const id = typeof input.id === "string" ? input.id : null;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body : "";
  const scope = input.scope;
  const startsAt = parseDate(input.startsAt);
  const rawEndsAt = input.endsAt;
  const endsAt =
    rawEndsAt === null || rawEndsAt === undefined || rawEndsAt === "" ? null : parseDate(rawEndsAt);
  const targets = parseTargets(input.targets);
  const groupIds = Array.isArray(input.groupIds)
    ? [...new Set(input.groupIds.filter((value): value is string => typeof value === "string"))]
    : null;

  if (title.length === 0 || title.length > 200) {
    return { ok: false, code: "invalid_title" };
  }

  if (body.length > 100_000) {
    return { ok: false, code: "invalid_body" };
  }

  if (scope !== "global" && scope !== "forums") {
    return { ok: false, code: "invalid_scope" };
  }

  const invalidEnds =
    rawEndsAt !== null && rawEndsAt !== undefined && rawEndsAt !== "" && endsAt === null;

  if (
    startsAt === null ||
    invalidEnds ||
    (endsAt !== null && endsAt.getTime() <= startsAt.getTime())
  ) {
    return { ok: false, code: "invalid_schedule" };
  }

  if (targets === null || groupIds === null) {
    return { ok: false, code: "invalid_request" };
  }

  if (scope === "global" && targets.length > 0) {
    return { ok: false, code: "invalid_target" };
  }

  if (scope === "forums" && targets.length === 0) {
    return { ok: false, code: "invalid_target" };
  }

  if (targets.length > 0) {
    const found = (await sql`
      SELECT id FROM core.forums WHERE id = ANY(${`{${targets.map((target) => target.forumId).join(",")}}`}::bigint[])
    `) as Array<{ id: string }>;

    if (found.length !== targets.length) {
      return { ok: false, code: "invalid_target" };
    }
  }

  const renderedBody = await saveContent(body, {
    profile: "rules",
    context: { kind: "forum_post", forumId: targets[0]?.forumId ?? "1" },
    authorId: actorMemberId,
    ...(await loadStaffContentRenderOptions(sql, actorMemberId)),
  });

  if (groupIds.length > 0) {
    const found = (await sql`
      SELECT id FROM core.groups WHERE id = ANY(${`{${groupIds.join(",")}}`}::bigint[])
    `) as Array<{ id: string }>;

    if (found.length !== groupIds.length) {
      return { ok: false, code: "invalid_group" };
    }
  }

  const before =
    id === null
      ? []
      : ((await sql`
          SELECT id, scope FROM core.announcements WHERE id = ${id}
        `) as Array<{ id: string; scope: AnnouncementScope }>);

  if (id !== null && before[0] === undefined) {
    return { ok: false, code: "not_found" };
  }

  const oldTargets =
    id === null
      ? []
      : (await targetsFor(sql, [id])).map((target) => ({
          forumId: target.forum_id,
          includeSubforums: target.include_subforums,
        }));
  const oldGlobal = before[0]?.scope === "global";
  const affectedForums = new Set([
    ...(await expandForumIds(sql, oldTargets)),
    ...(await expandForumIds(sql, targets)),
  ]);

  await runMutation({
    sql,
    mutation: announcementMutation,
    input: {
      announcementId: id ?? "0",
      scope,
      forumIds: [...affectedForums],
      bumpGlobal: oldGlobal || scope === "global",
    },
    apply: async (tx) => {
      let announcementId = id;

      if (announcementId === null) {
        const [row] = (await tx`
          INSERT INTO core.announcements (
            title, body, body_html, body_text, render_version, sanitiser_version,
            scope, starts_at, ends_at, dismissible, created_by
          )
          VALUES (
            ${title}, ${renderedBody.bodyMd}, ${renderedBody.bodyHtml},
            ${renderedBody.bodyText}, ${renderedBody.renderVersion},
            ${renderedBody.sanitiserVersion}, ${scope}, ${startsAt}, ${endsAt},
            ${input.dismissible !== false}, ${actorMemberId}
          )
          RETURNING id
        `) as Array<{ id: string }>;

        if (row === undefined) {
          throw new Error("Announcement insert returned no row");
        }

        announcementId = row.id;
      } else {
        await tx`
          UPDATE core.announcements
          SET title = ${title}, body = ${renderedBody.bodyMd},
              body_html = ${renderedBody.bodyHtml}, body_text = ${renderedBody.bodyText},
              render_version = ${renderedBody.renderVersion},
              sanitiser_version = ${renderedBody.sanitiserVersion},
              scope = ${scope}, starts_at = ${startsAt}, ends_at = ${endsAt},
              dismissible = ${input.dismissible !== false}
          WHERE id = ${announcementId}
        `;
        await tx`DELETE FROM core.announcement_targets WHERE announcement_id = ${announcementId}`;
        await tx`DELETE FROM core.announcement_groups WHERE announcement_id = ${announcementId}`;
      }

      for (const target of targets) {
        await tx`
          INSERT INTO core.announcement_targets (announcement_id, forum_id, include_subforums)
          VALUES (${announcementId}, ${target.forumId}, ${target.includeSubforums})
        `;
      }

      for (const groupId of groupIds) {
        await tx`
          INSERT INTO core.announcement_groups (announcement_id, group_id)
          VALUES (${announcementId}, ${groupId})
        `;
      }

      await writeAdminLog(tx, {
        actorMemberId,
        action: id === null ? "announcement.create" : "announcement.update",
        targetType: "announcement",
        targetId: announcementId,
        summary: {
          title,
          scope,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt?.toISOString() ?? null,
        },
      });
    },
  });

  return { ok: true };
}

export async function deleteAnnouncement(
  sql: SQL,
  actorMemberId: string,
  input: unknown,
): Promise<AnnouncementMutation> {
  if (!isRecord(input) || typeof input.id !== "string") {
    return { ok: false, code: "invalid_request" };
  }

  const [existing] = (await sql`
    SELECT id, scope, title FROM core.announcements WHERE id = ${input.id}
  `) as Array<{ id: string; scope: AnnouncementScope; title: string }>;

  if (existing === undefined) {
    return { ok: false, code: "not_found" };
  }

  const targets = (await targetsFor(sql, [existing.id])).map((target) => ({
    forumId: target.forum_id,
    includeSubforums: target.include_subforums,
  }));

  await runMutation({
    sql,
    mutation: announcementMutation,
    input: {
      announcementId: existing.id,
      scope: existing.scope,
      forumIds: await expandForumIds(sql, targets),
      bumpGlobal: existing.scope === "global",
    },
    apply: async (tx) => {
      await tx`DELETE FROM core.announcements WHERE id = ${existing.id}`;
      await writeAdminLog(tx, {
        actorMemberId,
        action: "announcement.delete",
        targetType: "announcement",
        targetId: existing.id,
        summary: { title: existing.title },
      });
    },
  });

  return { ok: true };
}
