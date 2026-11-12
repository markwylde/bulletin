import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { loadEvent } from "@bulletin/domain/events";
import { displayNameSkeleton, updateDisplayName } from "@bulletin/domain/member";
import { listNotifications } from "@bulletin/domain/notifications";
import {
  can,
  capabilityAnswer,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { saveMemberProfile } from "@bulletin/domain/profiles";
import { startTopic } from "@bulletin/domain/topics";
import {
  acknowledgeWarnings,
  activeWarningPoints,
  canViewWarningHistory,
  expireWarnings,
  hasUnacknowledgedWarning,
  issueWarning,
  listMemberRestrictions,
  listMemberWarnings,
  listStaffWarnings,
  listWarningReasons,
  revokeWarning,
  saveWarningReason,
  saveWarningThreshold,
} from "@bulletin/domain/warnings";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  memberWarningHistoryResponse,
  ownWarningsResponse,
} from "../../apps/user-api/src/warnings.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "warnings" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function seedReason(
  database: TestDatabase,
  input: {
    readonly key: string;
    readonly points?: number;
    readonly expiryDays?: number;
    readonly allowPointsOverride?: boolean;
  },
): Promise<string> {
  const saved = expectOk(
    await saveWarningReason(database.sql, {
      key: input.key,
      points: input.points ?? 3,
      expiryDays: input.expiryDays ?? 30,
      allowPointsOverride: input.allowPointsOverride ?? false,
      enabled: true,
      position: 0,
      labels: { en: input.key, es: input.key, fr: input.key },
    }),
  );

  return saved.id;
}

integrationDescribe("warnings", () => {
  test("pre-fills reason defaults, links a post warning and notifies the member", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const forum = await forumId(database, "off-topic");
      const reasonId = await seedReason(database, { key: "spam", points: 3, expiryDays: 30 });
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Warning target",
          bodyMd: "Reported body.",
        }),
      );

      const reasons = await listWarningReasons(database.sql, { enabledOnly: true });
      expect(reasons[0]).toMatchObject({
        key: "spam",
        points: 3,
        expiryDays: 30,
        labels: { en: "spam" },
      });

      const issued = expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: author,
          reasonId,
          points: 99,
          contentType: "post",
          contentId: topic.postId,
          memberNote: "Please keep it civil.",
          staffNote: "Second warning this month.",
        }),
      );
      expect(issued.points).toBe(3);

      const [warning] = (await database.sql`
        SELECT points, content_type, content_id::text AS content_id, expires_at,
          member_note, staff_note
        FROM core.warnings WHERE id = ${issued.warningId}
      `) as Array<{
        points: number;
        content_type: string;
        content_id: string;
        expires_at: Date;
        member_note: string;
        staff_note: string;
      }>;
      expect(warning?.points).toBe(3);
      expect(warning?.content_type).toBe("post");
      expect(warning?.content_id).toBe(topic.postId);
      expect(warning?.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);

      const [eventRow] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'warning.issued' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: string | bigint }>;
      const event = await loadEvent(database.sql, BigInt(eventRow?.id ?? "0"));
      expect(event).not.toBeNull();

      if (event !== null) {
        await createNotificationsEventHandler({ sql: database.sql })(event);
      }

      const notifications = await listNotifications(database.sql, author, { limit: 10 });
      expect(notifications[0]).toMatchObject({
        type: "warning.issued",
        warningId: issued.warningId,
        warningReason: "spam",
        warningNote: "Please keep it civil.",
      });

      const memberWarnings = await listMemberWarnings(database.sql, author, "en");
      expect(memberWarnings[0]?.memberNote).toBe("Please keep it civil.");
      expect(memberWarnings[0]?.staffNote).toBe("");

      const staffWarnings = await listStaffWarnings(database.sql, author, "en");
      expect(staffWarnings[0]?.staffNote).toBe("Second warning this month.");

      expect(
        await issueWarning(database.sql, {
          actorId: author,
          memberId: moderator,
          reasonId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 60_000);

  test("applies queue, suspension and ban thresholds and gates posting on acknowledgement", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const forum = await forumId(database, "off-topic");
      const reasonId = await seedReason(database, { key: "severe", points: 12 });

      for (const threshold of [
        { points: 4, action: "mod_queue" as const, durationHours: 24 },
        { points: 8, action: "suspend" as const, durationHours: 168 },
        { points: 12, action: "ban" as const, durationHours: null },
      ]) {
        expectOk(await saveWarningThreshold(database.sql, threshold));
      }

      const issued = expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: member,
          reasonId,
          ackRequired: true,
        }),
      );
      expect(issued.points).toBe(12);

      const restrictions = await listMemberRestrictions(database.sql, member);
      expect(restrictions.map((restriction) => restriction.kind).sort()).toEqual([
        "banned",
        "cannot_post",
        "posts_require_approval",
      ]);
      const suspended = restrictions.find((restriction) => restriction.kind === "cannot_post");
      expect(suspended?.until?.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      const banned = restrictions.find((restriction) => restriction.kind === "banned");
      expect(banned?.until).toBeNull();

      expect(await hasUnacknowledgedWarning(database.sql, member)).toBe(true);
      const blocked = await startTopic(database.sql, {
        actorId: member,
        forumId: forum,
        title: "Blocked by warnings",
        bodyMd: "This must not publish.",
      });
      expect(blocked).toEqual({ ok: false, code: "acknowledgement_required" });

      expect(await acknowledgeWarnings(database.sql, member)).toBe(1);
      expect(await hasUnacknowledgedWarning(database.sql, member)).toBe(false);
      const suspendedPost = await startTopic(database.sql, {
        actorId: member,
        forumId: forum,
        title: "Still suspended",
        bodyMd: "This must not publish either.",
      });
      expect(suspendedPost).toEqual({ ok: false, code: "posting_suspended" });
    });
  }, 60_000);

  test("a ban-only warning threshold blocks every capability and profile edits", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "super-mod");
      const moderator = await memberId(database, "admin");
      const forum = await forumId(database, "off-topic");
      const reasonId = await seedReason(database, { key: "ban_only", points: 1 });

      expectOk(
        await saveWarningThreshold(database.sql, {
          points: 1,
          action: "ban",
          durationHours: 24,
        }),
      );
      expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: member,
          reasonId,
        }),
      );

      const restrictions = await listMemberRestrictions(database.sql, member);
      expect(restrictions).toHaveLength(1);
      expect(restrictions[0]).toMatchObject({ kind: "banned" });
      expect(restrictions[0]?.until).toBeInstanceOf(Date);
      expect(await can(database.sql, member, "post")).toBe(false);
      expect(await can(database.sql, member, "react")).toBe(false);
      expect(await can(database.sql, member, "send_pm")).toBe(false);
      const tree = await loadForumTree(database.sql);
      const snapshot = await loadPermissionSnapshot(database.sql, member, { tree });
      expect(capabilityAnswer(snapshot, forum, "lock")).toBe(false);
      expect(capabilityAnswer(snapshot, forum, "use_multimod")).toBe(false);
      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "A warning ban must stop this edit.",
          hideOnline: false,
          hideFromMemberList: false,
          values: {},
          fields: [],
        }),
      ).toEqual({ ok: false, code: "banned" });
    });
  }, 60_000);

  test("a moderator on mandatory moderation is still held despite approve power", async () => {
    await withSeededDb(async (database) => {
      const moderator = await memberId(database, "super-mod");
      const forum = await forumId(database, "off-topic");
      await database.sql`
        INSERT INTO core.member_restrictions (member_id, kind, until)
        VALUES (${moderator}, 'posts_require_approval', now() + interval '1 day')
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: moderator,
          forumId: forum,
          title: "Moderator mandatory moderation",
          bodyMd: "Even moderators are held here.",
        }),
      );
      const [row] = (await database.sql`
        SELECT p.visibility, p.hold_reason, t.visibility AS topic_visibility
        FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
        WHERE p.id = ${topic.postId}
      `) as Array<{
        visibility: string;
        hold_reason: string | null;
        topic_visibility: string;
      }>;
      expect(row).toEqual({
        visibility: "unapproved",
        hold_reason: "warning",
        topic_visibility: "unapproved",
      });
    });
  }, 60_000);

  test("a display-name change is blocked by a warning or a posting suspension", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-2");

      await database.sql`
        INSERT INTO core.warnings (member_id, points, expires_at, ack_required, member_note)
        VALUES (${member}, 1, now() + interval '7 days', true, 'Please read this warning.')
      `;
      expect(
        await updateDisplayName(database.sql, member, {
          name: "Renamed While Warned",
          skeleton: displayNameSkeleton("Renamed While Warned"),
        }),
      ).toEqual({ kind: "acknowledgement_required" });

      await database.sql`DELETE FROM core.warnings WHERE member_id = ${member}`;
      await database.sql`
        INSERT INTO core.member_restrictions (member_id, kind, until)
        VALUES (${member}, 'cannot_post', now() + interval '7 days')
      `;
      expect(
        await updateDisplayName(database.sql, member, {
          name: "Renamed While Suspended",
          skeleton: displayNameSkeleton("Renamed While Suspended"),
        }),
      ).toEqual({ kind: "posting_suspended" });
    });
  }, 30_000);

  test("expires points automatically and keeps restrictions after revocation", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const reasonId = await seedReason(database, {
        key: "short",
        points: 5,
        expiryDays: 2,
        allowPointsOverride: true,
      });
      expectOk(
        await saveWarningThreshold(database.sql, {
          points: 5,
          action: "suspend",
          durationHours: 48,
        }),
      );

      const first = expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: member,
          reasonId,
          points: 7,
        }),
      );
      expect(await activeWarningPoints(database.sql, member)).toBe(7);
      expect((await listMemberRestrictions(database.sql, member))[0]?.kind).toBe("cannot_post");

      await database.sql`
        UPDATE core.warnings SET expires_at = now() - interval '1 minute'
        WHERE id = ${first.warningId}
      `;
      expect(await expireWarnings(database.sql)).toBe(1);
      expect(await activeWarningPoints(database.sql, member)).toBe(0);
      const [expired] = (await database.sql`
        SELECT expired_at FROM core.warnings WHERE id = ${first.warningId}
      `) as Array<{ expired_at: Date | null }>;
      expect(expired?.expired_at).toBeInstanceOf(Date);

      // A later revocation lowers points immediately, but a threshold restriction stays.
      const second = expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: member,
          reasonId,
        }),
      );
      expect(await activeWarningPoints(database.sql, member)).toBe(5);
      expectOk(
        await revokeWarning(database.sql, {
          actorId: moderator,
          warningId: second.warningId,
          reason: "Issued by mistake.",
        }),
      );
      expect(await activeWarningPoints(database.sql, member)).toBe(0);
      expect((await listMemberRestrictions(database.sql, member)).length).toBeGreaterThan(0);
    });
  }, 60_000);

  test("requires this session's password unlock to warn, revoke and read history", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "member-2");
      const forum = await forumId(database, "general-discussion");
      const reasonId = await seedReason(database, { key: "locked_note", points: 1 });

      // This member only has the warn power in the password forum, so any other forum's
      // open warn power cannot mask a missing session unlock.
      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (${forum}, ${moderator}, '{warn}'::text[], true)
      `;
      const [authorSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${author}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (authorSession === undefined) {
        throw new Error("Could not create the author session");
      }

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${authorSession.id}, 'forum_password', ${forum})
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          sessionId: authorSession.id,
          title: "Locked warning target",
          bodyMd: "A post behind a password.",
        }),
      );
      const [staffSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${moderator}, 'staff', decode(md5(random()::text), 'hex'), now() + interval '1 hour')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (staffSession === undefined) {
        throw new Error("Could not create the staff session");
      }

      // The member-level warn power reaches the forum, but this session has not unlocked it.
      expect(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: author,
          reasonId,
          contentType: "post",
          contentId: topic.postId,
          sessionId: staffSession.id,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect(await canViewWarningHistory(database.sql, moderator, staffSession.id)).toBe(false);

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${staffSession.id}, 'forum_password', ${forum})
      `;
      const issued = expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: author,
          reasonId,
          contentType: "post",
          contentId: topic.postId,
          sessionId: staffSession.id,
        }),
      );
      expect(await canViewWarningHistory(database.sql, moderator, staffSession.id)).toBe(true);

      await database.sql`
        UPDATE core.session_grants
        SET expires_at = now() - interval '1 minute'
        WHERE session_id = ${staffSession.id} AND kind = 'forum_password'
      `;
      expect(await canViewWarningHistory(database.sql, moderator, staffSession.id)).toBe(false);
      expect(
        await revokeWarning(database.sql, {
          actorId: moderator,
          warningId: issued.warningId,
          reason: "No longer locked",
          sessionId: staffSession.id,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 60_000);

  test("shows staff notes only to warning moderators and denies other members", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const outsider = await memberId(database, "member-2");
      const reasonId = await seedReason(database, { key: "note", points: 1 });

      expectOk(
        await issueWarning(database.sql, {
          actorId: moderator,
          memberId: member,
          reasonId,
          memberNote: "Visible note",
          staffNote: "Private note",
        }),
      );

      expect(await canViewWarningHistory(database.sql, outsider)).toBe(false);
      expect(await canViewWarningHistory(database.sql, moderator)).toBe(true);

      const own = await ownWarningsResponse(database.sql, { memberId: member });
      const ownBody = (await own.json()) as {
        warnings: Array<{ memberNote: string; staffNote: string }>;
      };
      expect(ownBody.warnings[0]).toMatchObject({
        memberNote: "Visible note",
        staffNote: "",
      });

      const denied = await memberWarningHistoryResponse(
        database.sql,
        { memberId: outsider },
        member,
        new Request("http://bulletin.localhost/api/moderation/warnings/1"),
      );
      expect(denied.status).toBe(403);

      const full = await memberWarningHistoryResponse(
        database.sql,
        { memberId: moderator },
        member,
        new Request("http://bulletin.localhost/api/moderation/warnings/1"),
      );
      expect(full.status).toBe(200);
      const fullBody = (await full.json()) as {
        warnings: Array<{ memberNote: string; staffNote: string }>;
      };
      expect(fullBody.warnings[0]).toMatchObject({
        memberNote: "Visible note",
        staffNote: "Private note",
      });
    });
  }, 60_000);
});
