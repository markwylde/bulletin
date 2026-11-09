import type { HealthCheck } from "@bulletin/config/server";
import type { AuthService, SessionRecord } from "@bulletin/domain/auth";
import {
  type AcpPermission,
  can,
  isAcpPermission,
  isStaffScheme,
} from "@bulletin/domain/permissions";
import type { SQL } from "bun";

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
  readonly method: "GET" | "POST";
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

interface AdminLogEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

async function recentAdminLog(sql: SQL): Promise<AdminLogEntry[]> {
  const rows = (await sql`
    SELECT
      a.id,
      m.display_name AS actor,
      a.action,
      a.target_type,
      a.target_id,
      a.created_at
    FROM core.admin_log a
    LEFT JOIN core.members m ON m.id = a.actor_member_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 10
  `) as Array<{
    id: string;
    actor: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    id: String(row.id),
    actor: row.actor,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id === null ? null : String(row.target_id),
    createdAt: row.created_at.toISOString(),
  }));
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

  await context.sql`
    INSERT INTO core.member_prefs (member_id, staff_scheme)
    VALUES (${context.session.memberId}, ${body.scheme})
    ON CONFLICT (member_id) DO UPDATE
      SET staff_scheme = EXCLUDED.staff_scheme,
          updated_at = now()
  `;

  return json({ scheme: body.scheme });
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
    handler: async ({ sql }) => json({ entries: await recentAdminLog(sql) }),
  },
  {
    id: "dashboard.health",
    method: "GET",
    path: "/api/staff/dashboard/health",
    permission: "acp.system",
    handler: async ({ checks }) => json(await systemHealth(checks)),
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

function findRoute(pathname: string): StaffRoute | undefined {
  return STAFF_ROUTES.find((route) => route.path === pathname);
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
        const route = findRoute(url.pathname);

        if (route === undefined) {
          return json({ code: "not_found" }, 404);
        }

        if (route.method !== request.method) {
          return json({ code: "method_not_allowed" }, 405);
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
