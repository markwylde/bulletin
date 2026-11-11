import type { SQL } from "bun";

export type FriendState = "none" | "pending_out" | "pending_in" | "friends";

export interface Friend {
  readonly id: string;
  readonly displayName: string;
  readonly avatarHash: string | null;
  readonly since: Date;
}

export interface IncomingFriendRequest {
  readonly id: string;
  readonly displayName: string;
  readonly requestedAt: Date;
}

/** Canonical member order for the single friendship row between two members. */
function ordered(a: string, b: string): readonly [string, string] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

export async function insertIgnore(sql: SQL, memberId: string, ignoredId: string): Promise<void> {
  await sql`
    INSERT INTO core.member_ignores (member_id, ignored_id)
    VALUES (${memberId}, ${ignoredId})
    ON CONFLICT DO NOTHING
  `;
}

export async function deleteIgnore(sql: SQL, memberId: string, ignoredId: string): Promise<void> {
  await sql`
    DELETE FROM core.member_ignores
    WHERE member_id = ${memberId} AND ignored_id = ${ignoredId}
  `;
}

export async function isIgnoring(sql: SQL, memberId: string, ignoredId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM core.member_ignores
    WHERE member_id = ${memberId} AND ignored_id = ${ignoredId}
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

export async function listIgnoredIds(sql: SQL, memberId: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT ignored_id::text AS id
    FROM core.member_ignores
    WHERE member_id = ${memberId}
    ORDER BY created_at DESC, ignored_id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

/** Accepted friends with the fields a profile's friend list needs. */
export async function listFriends(sql: SQL, memberId: string): Promise<readonly Friend[]> {
  const rows = (await sql`
    SELECT
      m.id::text AS id,
      m.display_name,
      m.avatar_hash,
      f.updated_at
    FROM core.friendships f
    JOIN core.members m
      ON m.id = CASE
        WHEN f.a_member_id = ${memberId} THEN f.b_member_id
        ELSE f.a_member_id
      END
    WHERE (f.a_member_id = ${memberId} OR f.b_member_id = ${memberId})
      AND f.state = 'accepted'
      AND m.display_name IS NOT NULL
    ORDER BY m.display_name, m.id
  `) as Array<{
    id: string;
    display_name: string;
    avatar_hash: string | null;
    updated_at: Date;
  }>;

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    avatarHash: row.avatar_hash,
    since: new Date(row.updated_at),
  }));
}

export async function listIncomingFriendRequests(
  sql: SQL,
  memberId: string,
): Promise<readonly IncomingFriendRequest[]> {
  const rows = (await sql`
    SELECT m.id::text AS id, m.display_name, f.created_at
    FROM core.friendships f
    JOIN core.members m ON m.id = f.requested_by
    WHERE (f.a_member_id = ${memberId} OR f.b_member_id = ${memberId})
      AND f.state = 'pending'
      AND f.requested_by <> ${memberId}
      AND m.display_name IS NOT NULL
    ORDER BY f.created_at DESC
  `) as Array<{ id: string; display_name: string; created_at: Date }>;

  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    requestedAt: new Date(row.created_at),
  }));
}

interface FriendshipRow {
  readonly state: "pending" | "accepted";
  readonly requested_by: string;
}

export async function readFriendship(
  sql: SQL,
  firstId: string,
  secondId: string,
): Promise<FriendshipRow | null> {
  const [a, b] = ordered(firstId, secondId);
  const [row] = (await sql`
    SELECT state, requested_by::text AS requested_by
    FROM core.friendships
    WHERE a_member_id = ${a} AND b_member_id = ${b}
  `) as FriendshipRow[];

  return row ?? null;
}

/** The viewer-relative state shown by the profile's action buttons. */
export async function readFriendState(
  sql: SQL,
  viewerId: string,
  targetId: string,
): Promise<FriendState> {
  const row = await readFriendship(sql, viewerId, targetId);

  if (row === null) {
    return "none";
  }

  if (row.state === "accepted") {
    return "friends";
  }

  return row.requested_by === viewerId ? "pending_out" : "pending_in";
}

export async function insertFriendRequest(sql: SQL, fromId: string, toId: string): Promise<void> {
  const [a, b] = ordered(fromId, toId);

  await sql`
    INSERT INTO core.friendships (a_member_id, b_member_id, state, requested_by)
    VALUES (${a}, ${b}, 'pending', ${fromId})
    ON CONFLICT DO NOTHING
  `;
}

export async function acceptFriendRequest(
  tx: SQL,
  firstId: string,
  secondId: string,
): Promise<void> {
  const [a, b] = ordered(firstId, secondId);

  await tx`
    UPDATE core.friendships
    SET state = 'accepted', updated_at = now()
    WHERE a_member_id = ${a} AND b_member_id = ${b} AND state = 'pending'
  `;
}

export async function deleteFriendship(sql: SQL, firstId: string, secondId: string): Promise<void> {
  const [a, b] = ordered(firstId, secondId);

  await sql`
    DELETE FROM core.friendships
    WHERE a_member_id = ${a} AND b_member_id = ${b}
  `;
}
