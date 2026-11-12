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

export async function readPostIp(sql: SQL, grantId: string): Promise<PostIpResult | null> {
  if (!/^\d+$/.test(grantId)) {
    return null;
  }

  const rows = (await sql`
    SELECT ip, expired FROM pii.read_post_ip(${grantId})
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

export async function readMembersByIp(sql: SQL, grantId: string): Promise<readonly MemberFromIp[]> {
  if (!/^\d+$/.test(grantId)) {
    return [];
  }

  const rows = (await sql`
    SELECT member_id::text AS member_id, display_name, post_id::text AS post_id,
      forum_id::text AS forum_id, created_at
    FROM pii.read_members_by_ip(${grantId})
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

export async function readLoginIps(sql: SQL, grantId: string): Promise<readonly LoginIp[]> {
  if (!/^\d+$/.test(grantId)) {
    return [];
  }

  const rows = (await sql`
    SELECT ip, created_at FROM pii.read_login_ips(${grantId})
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

export async function purgeExpiredPii(
  sql: SQL,
): Promise<{ readonly postIps: number; readonly loginIps: number; readonly accessLog: number }> {
  const rows = (await sql`
    SELECT post_ips, login_ips, access_log FROM pii.purge_expired()
  `) as Array<{
    post_ips: string | number;
    login_ips: string | number;
    access_log: string | number;
  }>;
  const row = rows[0];

  return {
    postIps: Number(row?.post_ips ?? 0),
    loginIps: Number(row?.login_ips ?? 0),
    accessLog: Number(row?.access_log ?? 0),
  };
}
