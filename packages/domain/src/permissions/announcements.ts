import { bumpCacheTags, forumAnnouncementsTag, GLOBAL_CACHE_TAGS } from "@bulletin/cache";
import type { SQL } from "bun";
import { can } from "./can.ts";
import { announcementAudience } from "./capability.ts";
import type { ViewerPrincipal } from "./principal.ts";
import { loadPermissionSnapshot, type PermissionSnapshot } from "./snapshot.ts";
import type { ForumTree } from "./tree.ts";
import { loadForumTree } from "./tree-store.ts";

export type AnnouncementScope = "global" | "forums";

export interface AnnouncementTarget {
  readonly forumId: string;
  readonly includeSubforums: boolean;
  /** The target forum's materialised path, used for subtree matching. */
  readonly forumPath: string;
}

export interface Announcement {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly scope: AnnouncementScope;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly dismissible: boolean;
  readonly version: number;
  readonly targetGroupIds: readonly string[];
  readonly targets: readonly AnnouncementTarget[];
}

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
  readonly forum_path: string;
}

export interface ForumScope {
  readonly id: string;
  readonly path: string;
}

/**
 * Loads every announcement that may still affect a cached page: active now, or starting in the
 * future. Expired announcements are never needed for rendering, the audience class or the next
 * transition. Group targeting is data, never an inline permission check (ADR 0005).
 */
export async function loadAnnouncements(
  sql: SQL,
  now: Date = new Date(),
): Promise<readonly Announcement[]> {
  const rows = (await sql`
    SELECT id, title, body, scope, starts_at, ends_at, dismissible, version
    FROM core.announcements
    WHERE ends_at IS NULL OR ends_at > ${now}
    ORDER BY starts_at DESC, id DESC
  `) as AnnouncementRow[];

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const targets = (await sql`
    SELECT t.announcement_id, t.forum_id, t.include_subforums, f.path::text AS forum_path
    FROM core.announcement_targets t
    JOIN core.forums f ON f.id = t.forum_id
    WHERE t.announcement_id = ANY(${`{${ids.join(",")}}`}::bigint[])
  `) as TargetRow[];
  const groups = (await sql`
    SELECT announcement_id, group_id
    FROM core.announcement_groups
    WHERE announcement_id = ANY(${`{${ids.join(",")}}`}::bigint[])
  `) as Array<{ announcement_id: string; group_id: string }>;
  const targetsByAnnouncement = new Map<string, AnnouncementTarget[]>();
  const groupsByAnnouncement = new Map<string, string[]>();

  for (const target of targets) {
    const list = targetsByAnnouncement.get(target.announcement_id) ?? [];
    list.push({
      forumId: target.forum_id,
      includeSubforums: target.include_subforums,
      forumPath: target.forum_path,
    });
    targetsByAnnouncement.set(target.announcement_id, list);
  }

  for (const group of groups) {
    const list = groupsByAnnouncement.get(group.announcement_id) ?? [];
    list.push(group.group_id);
    groupsByAnnouncement.set(group.announcement_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    scope: row.scope,
    startsAt: new Date(row.starts_at),
    endsAt: row.ends_at === null ? null : new Date(row.ends_at),
    dismissible: row.dismissible,
    version: row.version,
    targetGroupIds: groupsByAnnouncement.get(row.id) ?? [],
    targets: targetsByAnnouncement.get(row.id) ?? [],
  }));
}

export function isAnnouncementActive(announcement: Announcement, now: Date): boolean {
  return (
    announcement.startsAt.getTime() <= now.getTime() &&
    (announcement.endsAt === null || announcement.endsAt.getTime() > now.getTime())
  );
}

function targetsForum(announcement: Announcement, forum: ForumScope): boolean {
  if (announcement.scope === "global") {
    return true;
  }

  return announcement.targets.some(
    (target) =>
      target.forumId === forum.id ||
      (target.includeSubforums && forum.path.startsWith(`${target.forumPath}.`)),
  );
}

/** Active announcements a viewer may see on the board index. */
export function globalAnnouncements(
  announcements: readonly Announcement[],
  now: Date,
): readonly Announcement[] {
  return announcements.filter(
    (announcement) => announcement.scope === "global" && isAnnouncementActive(announcement, now),
  );
}

/** Active announcements for one forum page (global plus forum-scoped). */
export function announcementsForForum(
  announcements: readonly Announcement[],
  forum: ForumScope,
  now: Date,
): readonly Announcement[] {
  return announcements.filter(
    (announcement) => isAnnouncementActive(announcement, now) && targetsForum(announcement, forum),
  );
}

export interface AnnouncementVisibilityScope {
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
  readonly forumId?: string | null;
}

/** Removes announcements the viewer cannot see, through the single `can()` entry point. */
export async function filterVisibleAnnouncements(
  sql: SQL,
  principal: ViewerPrincipal,
  announcements: readonly Announcement[],
  scope: AnnouncementVisibilityScope,
): Promise<readonly Announcement[]> {
  const visible: Announcement[] = [];

  for (const announcement of announcements) {
    if (
      await can(sql, principal, "view_announcement", {
        announcementId: announcement.id,
        tree: scope.tree,
        snapshot: scope.snapshot,
        forumId: scope.forumId ?? null,
      })
    ) {
      visible.push(announcement);
    }
  }

  return visible;
}

/**
 * The viewer's announcement audience class (ADR 0005): active announcements whose target
 * groups include one of the viewer's groups. It is part of the page variant key so a
 * group-targeted notice can never share cached HTML with the rest of the board.
 */
export function announcementAudienceClass(
  announcements: readonly Announcement[],
  groupIds: readonly string[],
  now: Date,
): string {
  return announcementAudience(
    { groupIds },
    announcements
      .filter((announcement) => isAnnouncementActive(announcement, now))
      .map((announcement) => ({
        id: announcement.id,
        targetGroupIds: announcement.targetGroupIds,
      })),
  );
}

/**
 * Milliseconds until the next start or end among the announcements relevant to a page. A
 * cached page must not outlive an announcement transition even if the minute worker is late.
 * Returns null when nothing will transition.
 */
export function nextAnnouncementTransitionMs(
  announcements: readonly Announcement[],
  now: Date,
): number | null {
  let next: number | null = null;

  for (const announcement of announcements) {
    for (const at of [announcement.startsAt, announcement.endsAt]) {
      if (at === null || at.getTime() <= now.getTime()) {
        continue;
      }

      const delta = at.getTime() - now.getTime();
      next = next === null ? delta : Math.min(next, delta);
    }
  }

  return next;
}

/**
 * Bumps the announcement block tags for announcements that started or ended since the previous
 * minute, so a page cached across the boundary is refreshed without a staff action (ADR 0006).
 */
export async function bumpAnnouncementTransitions(
  sql: SQL,
  now: Date = new Date(),
): Promise<readonly string[]> {
  const windowStart = new Date(now.getTime() - 60_000);

  return sql.begin(async (tx) => {
    const [global] = (await tx`
      SELECT EXISTS (
        SELECT 1 FROM core.announcements
        WHERE scope = 'global'
          AND (
            (starts_at > ${windowStart} AND starts_at <= ${now})
            OR (ends_at > ${windowStart} AND ends_at <= ${now})
          )
      ) AS transitioned
    `) as Array<{ transitioned: boolean }>;
    const forums = (await tx`
      SELECT DISTINCT f.id::text AS forum_id
      FROM core.announcements a
      JOIN core.announcement_targets t ON t.announcement_id = a.id
      JOIN core.forums target ON target.id = t.forum_id
      JOIN core.forums f ON
        (t.include_subforums AND f.path <@ target.path)
        OR (NOT t.include_subforums AND f.id = t.forum_id)
      WHERE a.scope = 'forums'
        AND (
          (a.starts_at > ${windowStart} AND a.starts_at <= ${now})
          OR (a.ends_at > ${windowStart} AND a.ends_at <= ${now})
        )
    `) as Array<{ forum_id: string }>;
    const tags = [
      ...(global?.transitioned === true ? [GLOBAL_CACHE_TAGS.announcements] : []),
      ...forums.map((row) => forumAnnouncementsTag(row.forum_id)),
    ].filter((tag, index, all) => all.indexOf(tag) === index);

    if (tags.length > 0) {
      await bumpCacheTags(tx, tags);
    }

    return tags;
  });
}

export type DismissAnnouncementResult = "ok" | "not_found" | "not_dismissible";

/** Records a member's dismissal at the announcement's current content version (ADR 0006). */
export async function dismissAnnouncement(
  sql: SQL,
  memberId: string,
  announcementId: string,
  now: Date = new Date(),
): Promise<DismissAnnouncementResult> {
  const [announcement] = (await sql`
    SELECT id, version, dismissible
    FROM core.announcements
    WHERE id = ${announcementId}
      AND starts_at <= ${now}
      AND (ends_at IS NULL OR ends_at > ${now})
  `) as Array<{ id: string; version: number; dismissible: boolean }>;

  if (announcement === undefined) {
    return "not_found";
  }

  if (!announcement.dismissible) {
    return "not_dismissible";
  }

  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, memberId, { tree });

  if (
    !(await can(sql, memberId, "view_announcement", {
      announcementId: announcement.id,
      tree,
      snapshot,
    }))
  ) {
    return "not_found";
  }

  await sql`
    INSERT INTO core.announcement_dismissals (member_id, announcement_id, version)
    VALUES (${memberId}, ${announcement.id}, ${announcement.version})
    ON CONFLICT (member_id, announcement_id) DO UPDATE
      SET version = EXCLUDED.version, dismissed_at = now()
  `;

  return "ok";
}

/**
 * Active announcements whose dismissed version still matches the current content. Editing the
 * title or body bumps `version`, so the announcement reappears for everyone who dismissed it.
 */
export async function listDismissedAnnouncementIds(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT a.id::text AS id
    FROM core.announcement_dismissals d
    JOIN core.announcements a ON a.id = d.announcement_id
    WHERE d.member_id = ${memberId}
      AND d.version = a.version
      AND a.starts_at <= ${now}
      AND (a.ends_at IS NULL OR a.ends_at > ${now})
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}
