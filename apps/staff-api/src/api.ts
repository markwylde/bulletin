import type { CdnPurger } from "@bulletin/cache";
import type { HealthCheck } from "@bulletin/config/server";
import { type AuthService, type SessionRecord, STEP_UP_WINDOW_MS } from "@bulletin/domain/auth";
import {
  type AcpPermission,
  allForumTags,
  can,
  forumSubtreeTags,
  isAcpPermission,
  isStaffScheme,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import { listAdminLog, writeAdminLog } from "./admin-log.ts";
import {
  type AnnouncementMutation,
  deleteAnnouncement,
  listAnnouncementsAdmin,
  saveAnnouncement,
} from "./announcements.ts";
import { loadBoardSettings, saveBoardSettings } from "./board-settings.ts";
import { staffFeatureFlags, staffFlagEnabled } from "./features.ts";
import { listFlagLog, listFlags, saveFlagRules } from "./flags.ts";
import {
  createForum,
  deleteForum,
  type ForumMutation,
  listForumsAdmin,
  moveForum,
  saveForumSettings,
} from "./forums.ts";
import {
  createGroup,
  deleteGroup,
  type GroupMutation,
  listGroupSettings,
  listGroups,
  loadMemberGroupsForStaff,
  reorderGroups,
  saveGroupSetting,
  setMemberGroups,
  updateGroup,
} from "./groups.ts";
import {
  bulkToggleMatrix,
  deleteMask,
  linkGroupMask,
  listPermissionMatrix,
  type MaskMutation,
  saveMask,
  saveMatrixCell,
} from "./masks.ts";
import {
  deleteModerator,
  listModerators,
  type ModeratorMutation,
  saveModerator,
  searchModeratorMembers,
} from "./moderators.ts";
import { deletePrefix, listPrefixesAdmin, type PrefixMutation, savePrefix } from "./prefixes.ts";
import {
  deletePromotionRule,
  listPromotions,
  type PromotionMutation,
  savePromotionRule,
} from "./promotions.ts";
import {
  listActiveOverrides,
  revertOverride,
  saveOverrideSet,
  searchOverrideKeys,
} from "./string-overrides.ts";

export interface StaffRouteContext {
  readonly request: Request;
  readonly url: URL;
  readonly session: SessionRecord;
  readonly sql: SQL;
  readonly checks: readonly HealthCheck[];
  /** Best-effort CDN purge for visibility changes (ADR 0006). */
  readonly purge?: CdnPurger;
}

export interface StaffRoute {
  /** Stable id used by tests and, later, by the route audit log. */
  readonly id: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  /** Section permission; `acp.access` is also checked for every route. */
  readonly permission: AcpPermission;
  /** Sensitive permission mutations need fresh authentication (ADR 0018). */
  readonly requiresStepUp?: boolean;
  readonly handler: (context: StaffRouteContext) => Promise<Response> | Response;
}

export interface StaffApiOptions {
  readonly auth: AuthService;
  readonly sql: SQL;
  readonly checks?: readonly HealthCheck[];
  readonly purge?: CdnPurger;
}

export interface StaffApi {
  handle(request: Request): Promise<Response>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function forbidden(): Response {
  return json({ code: "forbidden" }, 403);
}

interface MemberStats {
  readonly total: number;
  readonly active: number;
  readonly joinedLast7Days: number;
}

async function memberStats(sql: SQL): Promise<MemberStats> {
  const [row] = (await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE last_active_at > now() - interval '15 minutes')::int AS active,
      count(*) FILTER (WHERE joined_at > now() - interval '7 days')::int AS joined_last_7_days
    FROM core.members
    WHERE is_service = false
  `) as Array<{ total: number; active: number; joined_last_7_days: number }>;

  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    joinedLast7Days: row?.joined_last_7_days ?? 0,
  };
}

async function systemHealth(checks: readonly HealthCheck[]): Promise<{
  readonly status: "ok" | "degraded";
  readonly checks: Readonly<Record<string, boolean>>;
}> {
  const results: Record<string, boolean> = {};
  let healthy = true;

  for (const check of checks) {
    let ok = false;

    try {
      ok = await check.check();
    } catch {
      ok = false;
    }

    results[check.name] = ok;
    healthy &&= ok;
  }

  return { status: healthy ? "ok" : "degraded", checks: results };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveScheme(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);

  if (!isRecord(body) || !isStaffScheme(body.scheme)) {
    return json({ code: "invalid_scheme" }, 400);
  }

  await context.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`bulletin.staff_prefs:${context.session.memberId}`})::bigint)`;
    const [existing] = (await tx`
      SELECT staff_scheme
      FROM core.member_prefs
      WHERE member_id = ${context.session.memberId}
    `) as Array<{ staff_scheme: string }>;
    const before = isStaffScheme(existing?.staff_scheme) ? existing.staff_scheme : "system";

    await tx`
      INSERT INTO core.member_prefs (member_id, staff_scheme)
      VALUES (${context.session.memberId}, ${body.scheme})
      ON CONFLICT (member_id) DO UPDATE
        SET staff_scheme = EXCLUDED.staff_scheme,
            updated_at = now()
    `;

    await writeAdminLog(tx, {
      actorMemberId: context.session.memberId,
      action: "staff.preferences.update",
      targetType: "staff_preference",
      targetId: context.session.memberId,
      summary: {
        before: { staffScheme: before },
        after: { staffScheme: body.scheme },
      },
    });
  });

  return json({ scheme: body.scheme });
}

async function boardSettings(context: StaffRouteContext): Promise<Response> {
  return json(await loadBoardSettings(context.sql));
}

async function updateBoardSettings(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const result = await saveBoardSettings(context.sql, context.session.memberId, body);

  if (!result.ok) {
    return json({ code: "invalid_settings", fields: result.fields }, 400);
  }

  return json(result.settings);
}

const DATE_FILTER = /^\d{4}-\d{2}-\d{2}$/;

function dateFilter(value: string | null): string | undefined | null {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  return DATE_FILTER.test(value) ? value : null;
}

async function logEntries(context: StaffRouteContext): Promise<Response> {
  const params = context.url.searchParams;
  const from = dateFilter(params.get("from"));
  const to = dateFilter(params.get("to"));
  const cursor = params.get("cursor");
  const limitParam = params.get("limit");

  if (from === null || to === null) {
    return json({ code: "invalid_date" }, 400);
  }

  if (cursor !== null && !/^\d+$/.test(cursor)) {
    return json({ code: "invalid_cursor" }, 400);
  }

  const limit = limitParam === null ? undefined : Number(limitParam);

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return json({ code: "invalid_limit" }, 400);
  }

  const page = await listAdminLog(context.sql, {
    actor: params.get("actor") ?? "",
    action: params.get("action") ?? "",
    ...(cursor === null ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  });

  return json(page);
}

async function overrideKeys(context: StaffRouteContext): Promise<Response> {
  return json({
    keys: await searchOverrideKeys(context.sql, context.url.searchParams.get("query") ?? ""),
  });
}

async function overrideList(context: StaffRouteContext): Promise<Response> {
  return json({ overrides: await listActiveOverrides(context.sql) });
}

async function overrideSave(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const result = await saveOverrideSet(context.sql, context.session.memberId, body);

  if (!result.ok) {
    return json(
      {
        code: result.code,
        ...(result.issues === undefined ? {} : { issues: result.issues }),
      },
      400,
    );
  }

  return json({ ok: true });
}

async function overrideRevert(context: StaffRouteContext): Promise<Response> {
  const result = await revertOverride(
    context.sql,
    context.session.memberId,
    context.url.searchParams.get("locale"),
    context.url.searchParams.get("key"),
  );

  if (!result.ok) {
    return json({ code: result.code }, result.code === "not_found" ? 404 : 400);
  }

  return json({ ok: true });
}

async function flagList(context: StaffRouteContext): Promise<Response> {
  return json({ flags: await listFlags(context.sql) });
}

async function flagLog(context: StaffRouteContext): Promise<Response> {
  return json({ entries: await listFlagLog(context.sql) });
}

async function flagSaveRules(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const result = await saveFlagRules(context.sql, context.session.memberId, body);

  if (!result.ok) {
    return json(
      {
        code: result.code,
        ...(result.fields === undefined ? {} : { fields: result.fields }),
      },
      result.code === "not_found" ? 404 : 400,
    );
  }

  return json(result.flag);
}

function mutationResponse(
  result:
    | GroupMutation
    | MaskMutation
    | ModeratorMutation
    | PromotionMutation
    | ForumMutation
    | PrefixMutation
    | AnnouncementMutation,
): Response {
  if (result.ok) {
    return json({ ok: true });
  }

  const status =
    result.code === "not_found"
      ? 404
      : result.code === "duplicate_key" ||
          result.code === "system_group" ||
          result.code === "system_mask" ||
          result.code === "replacement_required" ||
          result.code === "group_in_use" ||
          result.code === "prefix_required_needs_prefix" ||
          result.code === "topic_choice_required" ||
          result.code === "invalid_topic_choice"
        ? 409
        : 400;

  return json({ code: result.code }, status);
}

function actionOf(body: unknown): string | null {
  return isRecord(body) && typeof body.action === "string" ? body.action : null;
}

async function groupsList(context: StaffRouteContext): Promise<Response> {
  return json({ groups: await listGroups(context.sql) });
}

async function groupsMutate(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);

  switch (action) {
    case "create":
      return mutationResponse(await createGroup(context.sql, context.session.memberId, body));
    case "update":
      return mutationResponse(await updateGroup(context.sql, context.session.memberId, body));
    case "reorder":
      return mutationResponse(await reorderGroups(context.sql, context.session.memberId, body));
    case "delete":
      return mutationResponse(await deleteGroup(context.sql, context.session.memberId, body));
    case "setting":
      return mutationResponse(await saveGroupSetting(context.sql, context.session.memberId, body));
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

async function groupSettingsList(context: StaffRouteContext): Promise<Response> {
  return json(await listGroupSettings(context.sql));
}

async function memberGroupsGet(context: StaffRouteContext): Promise<Response> {
  const memberId = context.url.searchParams.get("memberId");

  if (memberId === null || !/^\d+$/.test(memberId)) {
    return json({ code: "invalid_request" }, 400);
  }

  const view = await loadMemberGroupsForStaff(context.sql, memberId);
  return view === null ? json({ code: "not_found" }, 404) : json(view);
}

async function memberGroupsSave(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  return mutationResponse(await setMemberGroups(context.sql, context.session.memberId, body));
}

async function masksList(context: StaffRouteContext): Promise<Response> {
  return json(await listPermissionMatrix(context.sql));
}

async function purgeSubtreeOf(context: StaffRouteContext, body: unknown): Promise<void> {
  if (context.purge === undefined || body === null || typeof body !== "object") {
    return;
  }

  const forumId = (body as Record<string, unknown>).forumId;

  if (typeof forumId !== "string") {
    return;
  }

  // Best effort with a short timeout; workers retry from the domain event (ADR 0006).
  await context.purge.purge(await forumSubtreeTags(context.sql, forumId));
}

async function purgeAllForums(context: StaffRouteContext): Promise<void> {
  if (context.purge === undefined) {
    return;
  }

  // Best effort with a short timeout; workers retry from the domain event (ADR 0006).
  await context.purge.purge(await allForumTags(context.sql));
}

async function masksMutate(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);

  switch (action) {
    case "save":
      return mutationResponse(await saveMask(context.sql, context.session.memberId, body));
    case "delete": {
      const result = await deleteMask(context.sql, context.session.memberId, body);

      if (result.ok) {
        await purgeAllForums(context);
      }

      return mutationResponse(result);
    }
    case "link": {
      const result = await linkGroupMask(context.sql, context.session.memberId, body);

      if (result.ok) {
        await purgeAllForums(context);
      }

      return mutationResponse(result);
    }
    case "cell": {
      const result = await saveMatrixCell(context.sql, context.session.memberId, body);

      if (result.ok) {
        await purgeSubtreeOf(context, body);
      }

      return mutationResponse(result);
    }
    case "bulk": {
      const result = await bulkToggleMatrix(context.sql, context.session.memberId, body);

      if (result.ok) {
        await purgeSubtreeOf(context, body);
      }

      return mutationResponse(result);
    }
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

async function forumsList(context: StaffRouteContext): Promise<Response> {
  return json(await listForumsAdmin(context.sql));
}

async function forumsMutate(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);
  const actor = context.session.memberId;

  switch (action) {
    case "create":
      return mutationResponse(await createForum(context.sql, actor, body));
    case "move":
      return mutationResponse(await moveForum(context.sql, actor, body));
    case "delete":
      return mutationResponse(await deleteForum(context.sql, actor, body));
    case "settings":
      return mutationResponse(await saveForumSettings(context.sql, actor, body));
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

async function prefixesList(context: StaffRouteContext): Promise<Response> {
  return json(await listPrefixesAdmin(context.sql));
}

async function prefixesMutate(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);

  switch (action) {
    case "save":
      return mutationResponse(await savePrefix(context.sql, context.session.memberId, body));
    case "delete":
      return mutationResponse(await deletePrefix(context.sql, context.session.memberId, body));
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

async function featuresList(context: StaffRouteContext): Promise<Response> {
  return json({ flags: await staffFeatureFlags(context.sql, context.session.memberId) });
}

async function announcementsList(context: StaffRouteContext): Promise<Response> {
  if (!(await staffFlagEnabled(context.sql, context.session.memberId, "announcements"))) {
    return json({ code: "not_found" }, 404);
  }

  return json(await listAnnouncementsAdmin(context.sql));
}

async function announcementsMutate(context: StaffRouteContext): Promise<Response> {
  if (!(await staffFlagEnabled(context.sql, context.session.memberId, "announcements"))) {
    return json({ code: "not_found" }, 404);
  }

  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);

  switch (action) {
    case "save":
      return mutationResponse(await saveAnnouncement(context.sql, context.session.memberId, body));
    case "delete":
      return mutationResponse(
        await deleteAnnouncement(context.sql, context.session.memberId, body),
      );
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

async function moderatorsList(context: StaffRouteContext): Promise<Response> {
  return json(await listModerators(context.sql));
}

async function moderatorMembers(context: StaffRouteContext): Promise<Response> {
  const query = context.url.searchParams.get("query") ?? "";
  const offsetParam = context.url.searchParams.get("offset");
  const limitParam = context.url.searchParams.get("limit");
  const offset = offsetParam === null ? 0 : Number(offsetParam);
  const limit = limitParam === null ? 50 : Number(limitParam);

  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  return json(await searchModeratorMembers(context.sql, query, offset, limit));
}

async function moderatorsMutate(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);

  switch (action) {
    case "save":
      return mutationResponse(await saveModerator(context.sql, context.session.memberId, body));
    case "delete":
      return mutationResponse(await deleteModerator(context.sql, context.session.memberId, body));
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

async function promotionsList(context: StaffRouteContext): Promise<Response> {
  return json(await listPromotions(context.sql));
}

async function promotionsMutate(context: StaffRouteContext): Promise<Response> {
  const body: unknown = await context.request.json().catch(() => null);
  const action = actionOf(body);

  switch (action) {
    case "save":
      return mutationResponse(await savePromotionRule(context.sql, context.session.memberId, body));
    case "delete":
      return mutationResponse(
        await deletePromotionRule(context.sql, context.session.memberId, body),
      );
    default:
      return json({ code: "invalid_request" }, 400);
  }
}

export const STAFF_ROUTES: readonly StaffRoute[] = [
  {
    id: "dashboard.members",
    method: "GET",
    path: "/api/staff/dashboard/members",
    permission: "acp.members",
    handler: async ({ sql }) => json(await memberStats(sql)),
  },
  {
    id: "dashboard.log",
    method: "GET",
    path: "/api/staff/dashboard/log",
    permission: "acp.log",
    handler: async ({ sql }) => json({ entries: (await listAdminLog(sql, { limit: 10 })).entries }),
  },
  {
    id: "dashboard.health",
    method: "GET",
    path: "/api/staff/dashboard/health",
    permission: "acp.system",
    handler: async ({ checks }) => json(await systemHealth(checks)),
  },
  {
    id: "log.list",
    method: "GET",
    path: "/api/staff/log",
    permission: "acp.log",
    handler: logEntries,
  },
  {
    id: "settings.board",
    method: "GET",
    path: "/api/staff/settings/board",
    permission: "acp.settings",
    handler: boardSettings,
  },
  {
    id: "settings.board.update",
    method: "POST",
    path: "/api/staff/settings/board",
    permission: "acp.settings",
    handler: updateBoardSettings,
  },
  {
    id: "i18n.keys",
    method: "GET",
    path: "/api/staff/i18n/keys",
    permission: "acp.strings",
    handler: overrideKeys,
  },
  {
    id: "i18n.overrides",
    method: "GET",
    path: "/api/staff/i18n/overrides",
    permission: "acp.strings",
    handler: overrideList,
  },
  {
    id: "i18n.overrides.save",
    method: "POST",
    path: "/api/staff/i18n/overrides",
    permission: "acp.strings",
    handler: overrideSave,
  },
  {
    id: "i18n.overrides.revert",
    method: "DELETE",
    path: "/api/staff/i18n/overrides",
    permission: "acp.strings",
    handler: overrideRevert,
  },
  {
    id: "preferences.scheme",
    method: "POST",
    path: "/api/staff/preferences/scheme",
    permission: "acp.access",
    handler: saveScheme,
  },
  {
    id: "flags.list",
    method: "GET",
    path: "/api/staff/flags",
    permission: "acp.flags",
    handler: flagList,
  },
  {
    id: "flags.log",
    method: "GET",
    path: "/api/staff/flags/log",
    permission: "acp.flags",
    handler: flagLog,
  },
  {
    id: "flags.rules.update",
    method: "POST",
    path: "/api/staff/flags",
    permission: "acp.flags",
    handler: flagSaveRules,
  },
  {
    id: "groups.list",
    method: "GET",
    path: "/api/staff/groups",
    permission: "acp.groups",
    handler: groupsList,
  },
  {
    id: "groups.update",
    method: "POST",
    path: "/api/staff/groups",
    permission: "acp.groups",
    requiresStepUp: true,
    handler: groupsMutate,
  },
  {
    id: "groups.settings.list",
    method: "GET",
    path: "/api/staff/groups/settings",
    permission: "acp.groups",
    handler: groupSettingsList,
  },
  {
    id: "groups.member.get",
    method: "GET",
    path: "/api/staff/groups/member",
    permission: "acp.members.groups",
    handler: memberGroupsGet,
  },
  {
    id: "groups.member.update",
    method: "POST",
    path: "/api/staff/groups/member",
    permission: "acp.members.groups",
    requiresStepUp: true,
    handler: memberGroupsSave,
  },
  {
    id: "masks.list",
    method: "GET",
    path: "/api/staff/masks",
    permission: "acp.permissions",
    handler: masksList,
  },
  {
    id: "masks.update",
    method: "POST",
    path: "/api/staff/masks",
    permission: "acp.permissions",
    requiresStepUp: true,
    handler: masksMutate,
  },
  {
    id: "features.list",
    method: "GET",
    path: "/api/staff/features",
    permission: "acp.access",
    handler: featuresList,
  },
  {
    id: "forums.list",
    method: "GET",
    path: "/api/staff/forums",
    permission: "acp.forums",
    handler: forumsList,
  },
  {
    id: "forums.mutate",
    method: "POST",
    path: "/api/staff/forums",
    permission: "acp.forums",
    handler: forumsMutate,
  },
  {
    id: "prefixes.list",
    method: "GET",
    path: "/api/staff/prefixes",
    permission: "acp.forums",
    handler: prefixesList,
  },
  {
    id: "prefixes.mutate",
    method: "POST",
    path: "/api/staff/prefixes",
    permission: "acp.forums",
    handler: prefixesMutate,
  },
  {
    id: "announcements.list",
    method: "GET",
    path: "/api/staff/announcements",
    permission: "acp.announcements",
    handler: announcementsList,
  },
  {
    id: "announcements.mutate",
    method: "POST",
    path: "/api/staff/announcements",
    permission: "acp.announcements",
    handler: announcementsMutate,
  },
  {
    id: "moderators.list",
    method: "GET",
    path: "/api/staff/moderators",
    permission: "acp.members",
    handler: moderatorsList,
  },
  {
    id: "moderators.members",
    method: "GET",
    path: "/api/staff/moderators/members",
    permission: "acp.members",
    handler: moderatorMembers,
  },
  {
    id: "moderators.update",
    method: "POST",
    path: "/api/staff/moderators",
    permission: "acp.members",
    requiresStepUp: true,
    handler: moderatorsMutate,
  },
  {
    id: "promotions.list",
    method: "GET",
    path: "/api/staff/promotions",
    permission: "acp.groups",
    handler: promotionsList,
  },
  {
    id: "promotions.update",
    method: "POST",
    path: "/api/staff/promotions",
    permission: "acp.groups",
    requiresStepUp: true,
    handler: promotionsMutate,
  },
];

/**
 * The single permission guard for every staff route. `acp.access` is always required, then the
 * section's own permission. The auth service repeats the `acp.access` check for sessions, so a
 * bug here cannot expose staff data to members.
 */
export async function authorizeStaffRoute(
  route: StaffRoute,
  context: StaffRouteContext,
): Promise<Response> {
  if (!(await can(context.sql, context.session.memberId, "acp.access"))) {
    return forbidden();
  }

  if (route.permission !== "acp.access" && !isAcpPermission(route.permission)) {
    return forbidden();
  }

  if (
    route.permission !== "acp.access" &&
    !(await can(context.sql, context.session.memberId, route.permission))
  ) {
    return forbidden();
  }

  if (
    route.requiresStepUp === true &&
    Date.now() - context.session.lastAuthAt.getTime() > STEP_UP_WINDOW_MS
  ) {
    return json({ code: "step_up_required" }, 401);
  }

  return route.handler(context);
}

function findRoute(method: string, pathname: string): StaffRoute | undefined {
  return STAFF_ROUTES.find((route) => route.method === method && route.path === pathname);
}

function knownPath(pathname: string): boolean {
  return STAFF_ROUTES.some((route) => route.path === pathname);
}

export function createStaffApi(options: StaffApiOptions): StaffApi {
  const checks = options.checks ?? [];

  return {
    async handle(request) {
      const response = await options.auth.handle(request, async ({ session }) => {
        if (session === null) {
          return json({ code: "unauthenticated" }, 401);
        }

        const url = new URL(request.url);
        const route = findRoute(request.method, url.pathname);

        if (route === undefined) {
          return knownPath(url.pathname)
            ? json({ code: "method_not_allowed" }, 405)
            : json({ code: "not_found" }, 404);
        }

        return authorizeStaffRoute(route, {
          request,
          url,
          session,
          sql: options.sql,
          checks,
          ...(options.purge === undefined ? {} : { purge: options.purge }),
        });
      });

      return response ?? json({ code: "not_found" }, 404);
    },
  };
}
