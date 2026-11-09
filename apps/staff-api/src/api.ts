import type { HealthCheck } from "@bulletin/config/server";
import type { AuthService, SessionRecord } from "@bulletin/domain/auth";
import {
  type AcpPermission,
  can,
  isAcpPermission,
  isStaffScheme,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import { type AdminLogEntry, listAdminLog, writeAdminLog } from "./admin-log.ts";
import { loadBoardSettings, saveBoardSettings } from "./board-settings.ts";
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
}

export interface StaffRoute {
  /** Stable id used by tests and, later, by the route audit log. */
  readonly id: string;
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  /** Section permission; `acp.access` is also checked for every route. */
  readonly permission: AcpPermission;
  readonly handler: (context: StaffRouteContext) => Promise<Response> | Response;
}

export interface StaffApiOptions {
  readonly auth: AuthService;
  readonly sql: SQL;
  readonly checks?: readonly HealthCheck[];
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

  if (from === null || to === null) {
    return json({ code: "invalid_date" }, 400);
  }

  const entries: AdminLogEntry[] = await listAdminLog(context.sql, {
    actor: params.get("actor") ?? "",
    action: params.get("action") ?? "",
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  });

  return json({ entries });
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
    handler: async ({ sql }) => json({ entries: await listAdminLog(sql, { limit: 10 }) }),
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
        });
      });

      return response ?? json({ code: "not_found" }, 404);
    },
  };
}
