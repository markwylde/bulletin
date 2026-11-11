import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { runMutation } from "../mutations/index.ts";
import { friendshipMutation } from "../mutations/members.ts";
import type { NotificationRecipientFilter } from "../notifications/repository.ts";
import { can } from "../permissions/can.ts";
import {
  acceptFriendRequest,
  deleteFriendship,
  deleteIgnore,
  type Friend,
  type FriendState,
  type IncomingFriendRequest,
  insertFriendRequest,
  insertIgnore,
  isIgnoring,
  listFriends,
  listIgnoredIds,
  listIncomingFriendRequests,
  readFriendState,
  readFriendship,
} from "./repository.ts";

export * from "./repository.ts";

const MEMBER_ID = /^[1-9]\d{0,18}$/;

export type RelationshipErrorCode =
  | "not_found"
  | "self"
  | "unignorable"
  | "blocked"
  | "already_friends"
  | "pending"
  | "no_request";

export type RelationshipOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RelationshipErrorCode };

async function memberExists(sql: SQL, memberId: string): Promise<boolean> {
  if (!MEMBER_ID.test(memberId)) {
    return false;
  }

  const rows = (await sql`
    SELECT 1 FROM core.members WHERE id = ${memberId} AND is_service = false LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

async function memberCanBeIgnored(sql: SQL, ignoredId: string): Promise<boolean> {
  return !(await can(sql, ignoredId, "unignorable"));
}

/** The relationship state the profile's action buttons and overlay need. */
export interface MemberRelationshipState {
  readonly friendState: FriendState;
  readonly ignoring: boolean;
  readonly canIgnore: boolean;
  readonly self: boolean;
}

export async function readMemberRelationshipState(
  sql: SQL,
  viewerId: string,
  targetId: string,
): Promise<MemberRelationshipState | null> {
  if (!(await memberExists(sql, targetId))) {
    return null;
  }

  return {
    friendState: await readFriendState(sql, viewerId, targetId),
    ignoring: await isIgnoring(sql, viewerId, targetId),
    canIgnore: viewerId !== targetId && (await memberCanBeIgnored(sql, targetId)),
    self: viewerId === targetId,
  };
}

/** Ignores a member unless their groups mark them unignorable (ignore-list spec). */
export async function ignoreMember(
  sql: SQL,
  input: { readonly memberId: string; readonly ignoredId: string },
): Promise<RelationshipOutcome> {
  if (input.memberId === input.ignoredId) {
    return { ok: false, code: "self" };
  }

  if (!(await memberExists(sql, input.ignoredId))) {
    return { ok: false, code: "not_found" };
  }

  if (!(await memberCanBeIgnored(sql, input.ignoredId))) {
    return { ok: false, code: "unignorable" };
  }

  await insertIgnore(sql, input.memberId, input.ignoredId);

  return { ok: true };
}

export async function unignoreMember(
  sql: SQL,
  input: { readonly memberId: string; readonly ignoredId: string },
): Promise<RelationshipOutcome> {
  if (input.memberId === input.ignoredId) {
    return { ok: false, code: "self" };
  }

  await deleteIgnore(sql, input.memberId, input.ignoredId);

  return { ok: true };
}

/** All member ids the viewer ignores; the overlay uses it to collapse posts. */
export function ignoredMemberIds(sql: SQL, memberId: string): Promise<readonly string[]> {
  return listIgnoredIds(sql, memberId);
}

/**
 * Drops a notification whose actor the recipient ignores. This is the extension point the
 * workers wire into the recipient fan-out (ADR 0011, ignore spec).
 */
export const ignoreRecipientFilter: NotificationRecipientFilter = async ({ sql, recipient }) => {
  if (recipient.actorId === null) {
    return true;
  }

  return !(await isIgnoring(sql, recipient.memberId, recipient.actorId));
};

export type FriendOutcome = RelationshipOutcome;

/** Sends a friend request; a reciprocal pending request accepts it immediately. */
export async function sendFriendRequest(
  sql: SQL,
  input: { readonly memberId: string; readonly targetId: string },
): Promise<FriendOutcome> {
  if (input.memberId === input.targetId) {
    return { ok: false, code: "self" };
  }

  if (!(await memberExists(sql, input.targetId))) {
    return { ok: false, code: "not_found" };
  }

  if (
    (await isIgnoring(sql, input.memberId, input.targetId)) ||
    (await isIgnoring(sql, input.targetId, input.memberId))
  ) {
    return { ok: false, code: "blocked" };
  }

  const existing = await readFriendship(sql, input.memberId, input.targetId);

  if (existing?.state === "accepted") {
    return { ok: false, code: "already_friends" };
  }

  if (existing?.state === "pending") {
    if (existing.requested_by === input.targetId) {
      await acceptFriendRequestFrom(sql, input.targetId, input.memberId);
      return { ok: true };
    }

    return { ok: false, code: "pending" };
  }

  await insertFriendRequest(sql, input.memberId, input.targetId);

  return { ok: true };
}

async function acceptFriendRequestFrom(
  sql: SQL,
  requesterId: string,
  accepterId: string,
): Promise<void> {
  await runMutation({
    sql,
    mutation: friendshipMutation,
    input: { memberIds: [requesterId, accepterId] },
    apply: async (tx) => {
      await acceptFriendRequest(tx, requesterId, accepterId);
      await emit(tx, {
        type: "friend.accepted",
        aggregateId: BigInt(requesterId),
        aggregateVersion: 1n,
        payloadIds: {
          requesterId: BigInt(requesterId),
          accepterId: BigInt(accepterId),
        },
      });
      return { memberIds: [requesterId, accepterId] };
    },
  });
}

/** Accepts or declines the pending request `requesterId` sent to `memberId`. */
export async function respondToFriendRequest(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly requesterId: string;
    readonly accept: boolean;
  },
): Promise<FriendOutcome> {
  const row = await readFriendship(sql, input.memberId, input.requesterId);

  if (
    row === null ||
    row.state !== "pending" ||
    row.requested_by !== input.requesterId ||
    row.requested_by === input.memberId
  ) {
    return { ok: false, code: "no_request" };
  }

  if (!input.accept) {
    await deleteFriendship(sql, input.memberId, input.requesterId);
    return { ok: true };
  }

  await acceptFriendRequestFrom(sql, input.requesterId, input.memberId);

  return { ok: true };
}

export async function removeFriend(
  sql: SQL,
  input: { readonly memberId: string; readonly friendId: string },
): Promise<FriendOutcome> {
  const row = await readFriendship(sql, input.memberId, input.friendId);

  if (row === null || row.state !== "accepted") {
    return { ok: false, code: "no_request" };
  }

  await runMutation({
    sql,
    mutation: friendshipMutation,
    input: { memberIds: [input.memberId, input.friendId] },
    apply: async (tx) => {
      await deleteFriendship(tx, input.memberId, input.friendId);
      return { memberIds: [input.memberId, input.friendId] };
    },
  });

  return { ok: true };
}

export function friendsForMember(sql: SQL, memberId: string): Promise<readonly Friend[]> {
  return listFriends(sql, memberId);
}

export function incomingRequestsForMember(
  sql: SQL,
  memberId: string,
): Promise<readonly IncomingFriendRequest[]> {
  return listIncomingFriendRequests(sql, memberId);
}
