import type { SQL } from "bun";

export type IpAccessPurpose = "post_ip" | "reverse_ip" | "login_ips";

/** Opens the audited grant; the caller must commit before reading. Null means denied. */
export async function openIpAccess(
  sql: SQL,
  input: {
    readonly sessionToken: string;
    readonly purpose: IpAccessPurpose;
    readonly resourceType: "post" | "member";
    readonly resourceId: string;
  },
): Promise<string | null> {
  const rows = (await sql`
    SELECT pii.open_access(
      ${input.sessionToken}, ${input.purpose}, ${input.resourceType}, ${input.resourceId}
    ) AS grant_id
  `) as Array<{ grant_id: string | null }>;

  return rows[0]?.grant_id ?? null;
}

export interface PostIpResult {
  readonly ip: string | null;
  readonly expired: boolean;
}

export async function readPostIp(
  sql: SQL,
  sessionToken: string,
  grantId: string,
): Promise<PostIpResult | null> {
  if (!/^\d+$/.test(grantId)) {
    return null;
  }

  const rows = (await sql`
    SELECT ip, expired FROM pii.read_post_ip(${sessionToken}, ${grantId})
  `) as Array<{ ip: string | null; expired: boolean }>;
  const row = rows[0];

  return row === undefined ? null : { ip: row.ip, expired: row.expired };
}

export interface MemberFromIp {
  readonly memberId: string;
  readonly displayName: string | null;
  readonly postId: string;
  readonly forumId: string;
  readonly createdAt: Date;
}

export async function readMembersByIp(
  sql: SQL,
  sessionToken: string,
  grantId: string,
): Promise<readonly MemberFromIp[]> {
  if (!/^\d+$/.test(grantId)) {
    return [];
  }

  const rows = (await sql`
    SELECT member_id::text AS member_id, display_name, post_id::text AS post_id,
      forum_id::text AS forum_id, created_at
    FROM pii.read_members_by_ip(${sessionToken}, ${grantId})
  `) as Array<{
    member_id: string;
    display_name: string | null;
    post_id: string;
    forum_id: string;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    memberId: row.member_id,
    displayName: row.display_name,
    postId: row.post_id,
    forumId: row.forum_id,
    createdAt: row.created_at,
  }));
}

export interface LoginIp {
  readonly ip: string;
  readonly createdAt: Date;
}

export async function readLoginIps(
  sql: SQL,
  sessionToken: string,
  grantId: string,
): Promise<readonly LoginIp[]> {
  if (!/^\d+$/.test(grantId)) {
    return [];
  }

  const rows = (await sql`
    SELECT ip, created_at FROM pii.read_login_ips(${sessionToken}, ${grantId})
  `) as Array<{ ip: string; created_at: Date }>;

  return rows.map((row) => ({ ip: row.ip, createdAt: row.created_at }));
}

/** Write-only post IP capture (ADR 0012); a malformed address is ignored. */
export async function recordPostIp(sql: SQL, postId: string, ip: string | null): Promise<void> {
  if (ip === null || ip === "" || !/^\d+$/.test(postId)) {
    return;
  }

  await sql`SELECT pii.record_post_ip(${postId}, ${ip}::inet)`;
}

export interface PiiPurgeResult {
  readonly postIps: number;
  readonly loginIps: number;
  readonly accessLog: number;
  readonly sessionMeta: number;
}

export async function purgeExpiredPii(sql: SQL, now: Date = new Date()): Promise<PiiPurgeResult> {
  const rows = (await sql`
    SELECT post_ips, login_ips, access_log, session_meta
    FROM pii.purge_expired(${now})
  `) as Array<{
    post_ips: string | number;
    login_ips: string | number;
    access_log: string | number;
    session_meta: string | number;
  }>;
  const row = rows[0];

  return {
    postIps: Number(row?.post_ips ?? 0),
    loginIps: Number(row?.login_ips ?? 0),
    accessLog: Number(row?.access_log ?? 0),
    sessionMeta: Number(row?.session_meta ?? 0),
  };
}

export interface ExpiredExport {
  readonly requestId: string;
  readonly exportKey: string;
}

export async function readExpiredExports(
  sql: SQL,
  now: Date = new Date(),
): Promise<readonly ExpiredExport[]> {
  const rows = (await sql`
    SELECT request_id::text AS request_id, export_key
    FROM pii.expired_exports(${now})
  `) as Array<{ request_id: string; export_key: string }>;

  return rows.map((row) => ({ requestId: row.request_id, exportKey: row.export_key }));
}

export async function clearExpiredExport(
  sql: SQL,
  requestId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = (await sql`
    SELECT pii.clear_expired_export(${requestId}, ${now}) AS cleared
  `) as Array<{ cleared: boolean }>;

  return rows[0]?.cleared === true;
}

export interface DataRequestRecord {
  readonly id: string;
  readonly memberId: string;
  readonly kind: string;
  readonly status: string;
  readonly reason: string | null;
  readonly decisionReason: string | null;
  readonly postAction: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly dueAt: Date;
  readonly completedAt: Date | null;
}

export interface DataRequestFilters {
  readonly status?: string;
  readonly kind?: string;
  readonly memberId?: string;
  readonly overdue?: boolean;
}

/** The staff queue; the definer function checks `privacy.requests` in SQL. */
export async function listDataRequests(
  sql: SQL,
  sessionToken: string,
  filters: DataRequestFilters = {},
): Promise<readonly DataRequestRecord[]> {
  const payload: Record<string, unknown> = {};

  if (filters.status !== undefined) {
    payload.status = filters.status;
  }

  if (filters.kind !== undefined) {
    payload.kind = filters.kind;
  }

  if (filters.memberId !== undefined) {
    payload.member_id = filters.memberId;
  }

  if (filters.overdue !== undefined) {
    payload.overdue = filters.overdue;
  }

  const rows = (await sql`
    SELECT id::text AS id, member_id::text AS member_id, kind, status, reason,
      decision_reason, post_action, created_at, updated_at, due_at, completed_at
    FROM pii.list_data_requests(${sessionToken}, ${payload}::jsonb)
  `) as Array<{
    id: string;
    member_id: string;
    kind: string;
    status: string;
    reason: string | null;
    decision_reason: string | null;
    post_action: string;
    created_at: Date;
    updated_at: Date;
    due_at: Date;
    completed_at: Date | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    memberId: row.member_id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    decisionReason: row.decision_reason,
    postAction: row.post_action,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
  }));
}

export async function updateDataRequest(
  sql: SQL,
  sessionToken: string,
  requestId: string,
  action: "process" | "complete" | "reject",
  reason: string | null,
): Promise<void> {
  await sql`
    SELECT pii.update_data_request(${sessionToken}, ${requestId}, ${action}, ${reason})
  `;
}

export async function setDataRequestPostAction(
  sql: SQL,
  sessionToken: string,
  requestId: string,
  postAction: "anonymise" | "delete",
): Promise<boolean> {
  const rows = (await sql`
    SELECT pii.set_data_request_post_action(${sessionToken}, ${requestId}, ${postAction}) AS ok
  `) as Array<{ ok: boolean }>;

  return rows[0]?.ok === true;
}

export interface AccessLogEntry {
  readonly id: string;
  readonly actorMemberId: string | null;
  readonly subjectMemberId: string | null;
  readonly purpose: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly createdAt: Date;
}

export interface AccessLogFilters {
  readonly actorMemberId?: string;
  readonly subjectMemberId?: string;
  readonly purpose?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

/** Opens the two-transaction audit grant; the caller must commit before reading. */
export async function openAccessLog(sql: SQL, sessionToken: string): Promise<string | null> {
  const rows = (await sql`
    SELECT pii.open_access(${sessionToken}, 'access_log', 'access_log', 0) AS grant_id
  `) as Array<{ grant_id: string | null }>;

  return rows[0]?.grant_id ?? null;
}

export async function readAccessLog(
  sql: SQL,
  sessionToken: string,
  grantId: string,
  filters: AccessLogFilters = {},
): Promise<readonly AccessLogEntry[]> {
  if (!/^\d+$/.test(grantId)) {
    return [];
  }

  const payload: Record<string, unknown> = {};

  if (filters.actorMemberId !== undefined) {
    payload.actor_member_id = filters.actorMemberId;
  }

  if (filters.subjectMemberId !== undefined) {
    payload.subject_member_id = filters.subjectMemberId;
  }

  if (filters.purpose !== undefined) {
    payload.purpose = filters.purpose;
  }

  if (filters.from !== undefined) {
    payload.from = /^\d{4}-\d{2}-\d{2}$/.test(filters.from)
      ? `${filters.from}T00:00:00.000Z`
      : filters.from;
  }

  if (filters.to !== undefined) {
    payload.to = /^\d{4}-\d{2}-\d{2}$/.test(filters.to)
      ? `${filters.to}T23:59:59.999Z`
      : filters.to;
  }

  if (filters.limit !== undefined) {
    payload.limit = filters.limit;
  }

  const rows = (await sql`
    SELECT id::text AS id, actor_member_id::text AS actor_member_id,
      subject_member_id::text AS subject_member_id, purpose, resource_type,
      resource_id, created_at
    FROM pii.read_access_log(${sessionToken}, ${grantId}, ${payload}::jsonb)
  `) as Array<{
    id: string;
    actor_member_id: string | null;
    subject_member_id: string | null;
    purpose: string;
    resource_type: string | null;
    resource_id: string | null;
    created_at: Date;
  }>;

  return rows.map((row) => ({
    id: row.id,
    actorMemberId: row.actor_member_id,
    subjectMemberId: row.subject_member_id,
    purpose: row.purpose,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: row.created_at,
  }));
}

export interface OwnDataRequest {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly dueAt: Date;
  readonly completedAt: Date | null;
  readonly exportExpiresAt: Date | null;
}

/** The member's own export/erasure requests, derived from their user session token. */
export async function ownDataRequests(
  sql: SQL,
  sessionToken: string,
): Promise<readonly OwnDataRequest[]> {
  const rows = (await sql`
    SELECT id::text AS id, kind, status, created_at, due_at, completed_at, export_expires_at
    FROM pii.own_data_requests(${sessionToken})
  `) as Array<{
    id: string;
    kind: string;
    status: string;
    created_at: Date;
    due_at: Date;
    completed_at: Date | null;
    export_expires_at: Date | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    exportExpiresAt: row.export_expires_at,
  }));
}
