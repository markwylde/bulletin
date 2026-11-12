import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { can } from "../permissions/can.ts";

export interface IpBanRecord {
  readonly id: string;
  readonly cidr: string;
  readonly reason: string;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

export interface MemberBanRecord {
  readonly id: string;
  readonly memberId: string;
  readonly reason: string;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export type BanOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly ok: false;
      readonly code: "forbidden" | "not_found" | "invalid_request" | "already_banned";
    };

/** The application compares the request address to core rows, never reading pii (ADR 0012). */
export async function isIpBanned(sql: SQL, ip: string | null): Promise<boolean> {
  if (ip === null || ip === "") {
    return false;
  }

  const rows = (await sql`
    SELECT 1 FROM core.ip_bans
    WHERE cidr >>= ${ip}::inet
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

export async function listIpBans(sql: SQL): Promise<readonly IpBanRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, host(cidr) || '/' || masklen(cidr) AS cidr, reason,
      expires_at, created_at, created_by::text AS created_by
    FROM core.ip_bans
    ORDER BY created_at DESC, id DESC
  `) as Array<{
    id: string;
    cidr: string;
    reason: string;
    expires_at: Date | null;
    created_at: Date;
    created_by: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    cidr: row.cidr,
    reason: row.reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

async function validInet(sql: SQL, value: string): Promise<boolean> {
  try {
    const rows = (await sql`SELECT ${value}::inet AS ip`) as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function banIp(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly cidr: string;
    readonly reason: string;
    readonly days?: number;
  },
): Promise<BanOutcome<{ readonly id: string }>> {
  if (
    !(await can(sql, input.actorId, "bans.ip")) ||
    input.reason.trim() === "" ||
    !(await validInet(sql, input.cidr))
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const days = input.days ?? 365;
  const expiresAt = days <= 0 ? null : new Date(Date.now() + days * 86_400_000);

  return sql.begin(async (tx) => {
    const rows = (await tx`
      INSERT INTO core.ip_bans (cidr, reason, expires_at, created_by)
      VALUES (${input.cidr}::inet, ${input.reason.trim().slice(0, 500)}, ${expiresAt}, ${input.actorId})
      ON CONFLICT (cidr) DO UPDATE
      SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
          created_by = EXCLUDED.created_by, created_at = now()
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (rows[0] === undefined) {
      throw new Error("Could not save the IP ban");
    }

    return { ok: true as const, result: { id: rows[0].id } };
  });
}

export async function removeIpBan(
  sql: SQL,
  input: { readonly actorId: string; readonly id: string },
): Promise<BanOutcome<{ readonly deleted: boolean }>> {
  if (!(await can(sql, input.actorId, "bans.ip"))) {
    return { ok: false, code: "forbidden" };
  }

  const rows = (await sql`
    DELETE FROM core.ip_bans WHERE id = ${input.id} RETURNING 1
  `) as unknown[];

  return { ok: true, result: { deleted: rows.length > 0 } };
}

interface GroupRow {
  readonly group_id: string;
  readonly is_primary: boolean;
}

export async function activeMemberBan(sql: SQL, memberId: string): Promise<MemberBanRecord | null> {
  const rows = (await sql`
    SELECT id::text AS id, member_id::text AS member_id, reason, expires_at, created_at
    FROM core.member_bans
    WHERE member_id = ${memberId}
      AND (expires_at IS NULL OR expires_at > now())
  `) as Array<{
    id: string;
    member_id: string;
    reason: string;
    expires_at: Date | null;
    created_at: Date;
  }>;
  const row = rows[0];

  return row === undefined
    ? null
    : {
        id: row.id,
        memberId: row.member_id,
        reason: row.reason,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
      };
}

/** Moves the member into Banned, remembering every previous group for timed restoration. */
export async function banMember(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly memberId: string;
    readonly reason: string;
    readonly days?: number;
  },
): Promise<BanOutcome<{ readonly id: string }>> {
  if (
    !(await can(sql, input.actorId, "members.ban")) ||
    !/^\d+$/.test(input.memberId) ||
    input.reason.trim() === ""
  ) {
    return { ok: false, code: "invalid_request" };
  }

  const days = input.days ?? 0;
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86_400_000) : null;

  return sql.begin(async (tx) => {
    const member = (await tx`
      SELECT id FROM core.members WHERE id = ${input.memberId} FOR UPDATE
    `) as unknown[];

    if (member.length === 0) {
      return { ok: false as const, code: "not_found" as const };
    }

    const existing = (await tx`
      SELECT id FROM core.member_bans WHERE member_id = ${input.memberId}
    `) as unknown[];

    if (existing.length > 0) {
      return { ok: false as const, code: "already_banned" as const };
    }

    const groups = (await tx`
      SELECT group_id::text AS group_id, is_primary FROM core.member_groups
      WHERE member_id = ${input.memberId}
      ORDER BY is_primary DESC, group_id
    `) as GroupRow[];
    const [banned] = (await tx`
      SELECT id::text AS id FROM core.groups WHERE key = 'banned'
    `) as Array<{ id: string }>;

    if (banned === undefined) {
      throw new Error("Missing Banned group");
    }

    const rows = (await tx`
      INSERT INTO core.member_bans (
        member_id, reason, expires_at, previous_groups, created_by
      )
      VALUES (
        ${input.memberId}, ${input.reason.trim().slice(0, 500)}, ${expiresAt},
        (${JSON.stringify(groups)}::text)::jsonb, ${input.actorId}
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    await tx`DELETE FROM core.member_groups WHERE member_id = ${input.memberId}`;
    await tx`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      VALUES (${input.memberId}, ${banned.id}, true)
    `;

    await emit(tx, {
      type: "member.banned",
      aggregateId: BigInt(input.memberId),
      aggregateVersion: 1n,
      payloadIds: {
        memberId: BigInt(input.memberId),
        actorId: BigInt(input.actorId),
      },
    });

    return { ok: true as const, result: { id: rows[0]?.id ?? "" } };
  });
}

export async function unbanMember(
  sql: SQL,
  input: { readonly actorId: string; readonly memberId: string },
): Promise<BanOutcome<{ readonly restored: boolean }>> {
  if (!(await can(sql, input.actorId, "members.ban"))) {
    return { ok: false, code: "forbidden" };
  }

  return sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT id::text AS id, previous_groups FROM core.member_bans
      WHERE member_id = ${input.memberId} FOR UPDATE
    `) as Array<{ id: string; previous_groups: GroupRow[] }>;
    const ban = rows[0];

    if (ban === undefined) {
      return { ok: true as const, result: { restored: false } };
    }

    await tx`DELETE FROM core.member_groups WHERE member_id = ${input.memberId}`;

    for (const group of ban.previous_groups) {
      await tx`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${input.memberId}, ${group.group_id}, ${group.is_primary})
        ON CONFLICT DO NOTHING
      `;
    }

    await tx`DELETE FROM core.member_bans WHERE id = ${ban.id}`;
    await emit(tx, {
      type: "member.unbanned",
      aggregateId: BigInt(input.memberId),
      aggregateVersion: 1n,
      payloadIds: { memberId: BigInt(input.memberId), actorId: BigInt(input.actorId) },
    });

    return { ok: true as const, result: { restored: true } };
  });
}

/** Timed bans restore the exact previous groups and remove the ban row. */
export async function restoreExpiredMemberBans(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT member_id::text AS member_id, id::text AS id, previous_groups
    FROM core.member_bans
    WHERE expires_at IS NOT NULL AND expires_at <= now()
    ORDER BY id
  `) as Array<{ member_id: string; id: string; previous_groups: GroupRow[] }>;

  for (const ban of rows) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM core.member_groups WHERE member_id = ${ban.member_id}`;

      for (const group of ban.previous_groups) {
        await tx`
          INSERT INTO core.member_groups (member_id, group_id, is_primary)
          VALUES (${ban.member_id}, ${group.group_id}, ${group.is_primary})
          ON CONFLICT DO NOTHING
        `;
      }

      await tx`DELETE FROM core.member_bans WHERE id = ${ban.id}`;
    });
  }

  return rows.length;
}
