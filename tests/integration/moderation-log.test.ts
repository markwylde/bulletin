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
import { hashToken } from "@bulletin/domain/auth";
import { banIp, banMember, removeIpBan, unbanMember } from "@bulletin/domain/bans";
import { replyToConversation, startConversation } from "@bulletin/domain/conversations";
import {
  approveHeldPosts,
  listModerationLog,
  moderatedForums,
  rejectHeldPosts,
} from "@bulletin/domain/moderation";
import { can, loadForumTree } from "@bulletin/domain/permissions";
import { recordPostIp } from "@bulletin/domain/pii";
import { createReport, readReportDetail, updateReport } from "@bulletin/domain/reports";
import {
  applyMultimod,
  editPost,
  hardDelete,
  lock,
  mergeTopics,
  move,
  pin,
  reply,
  restore,
  saveMultimodAction,
  softDelete,
  splitTopic,
  startTopic,
} from "@bulletin/domain/topics";
import {
  issueWarning,
  revokeWarning,
  saveWarningReason as saveReason,
} from "@bulletin/domain/warnings";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { openIpAccessResponse } from "../../apps/staff-api/src/ip-tools.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "moderation_log" }, async (database) => {
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

async function logActions(database: TestDatabase): Promise<string[]> {
  const rows = (await database.sql`
    SELECT action FROM core.moderation_log ORDER BY id
  `) as Array<{ action: string }>;
  return rows.map((row) => row.action);
}

integrationDescribe("moderation log", () => {
  test("every moderation action writes an entry and admins can filter them", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const target = await memberId(database, "member-2");
      const forum = await forumId(database, "off-topic");
      const staffForum = await forumId(database, "staff-room");
      const tree = await loadForumTree(database.sql);
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Log topic",
          bodyMd: "Opening post.",
        }),
      );
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Merge source",
          bodyMd: "Source post.",
        }),
      );
      const splitSource = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Split source",
          bodyMd: "Split opening.",
        }),
      );
      const splitPosts: string[] = [];

      for (const body of ["Split one.", "Split two."]) {
        splitPosts.push(
          expectOk(
            await reply(database.sql, {
              actorId: member,
              topicId: splitSource.topicId,
              bodyMd: body,
            }),
          ).postId,
        );
      }

      // Approval queue approve and reject.
      await database.sql`
        UPDATE core.forums SET require_approval_posts = true WHERE id = ${forum}
      `;
      const approvedPost = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: topic.topicId,
          bodyMd: "Approved by moderator.",
        }),
      );
      const rejectedPost = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: topic.topicId,
          bodyMd: "Rejected by moderator.",
        }),
      );
      expectOk(
        await approveHeldPosts(database.sql, {
          actorId: admin,
          postIds: [approvedPost.postId],
        }),
      );
      expectOk(
        await rejectHeldPosts(database.sql, {
          actorId: admin,
          postIds: [rejectedPost.postId],
        }),
      );

      await database.sql`
        UPDATE core.forums SET require_approval_posts = false WHERE id = ${forum}
      `;
      const deletedPost = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: splitSource.topicId,
          bodyMd: "Delete and restore me.",
        }),
      );
      expectOk(await softDelete(database.sql, { actorId: admin, postId: deletedPost.postId }));
      expectOk(await restore(database.sql, { actorId: admin, postId: deletedPost.postId }));
      const doomed = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Doomed log topic",
          bodyMd: "Hard delete me.",
        }),
      );
      expectOk(await hardDelete(database.sql, { actorId: admin, topicId: doomed.topicId }));

      expectOk(
        await editPost(database.sql, {
          actorId: admin,
          postId: topic.postId,
          bodyMd: "Moderator edit.",
        }),
      );
      expectOk(await pin(database.sql, { actorId: admin, topicId: topic.topicId, pinned: true }));
      expectOk(await lock(database.sql, { actorId: admin, topicId: topic.topicId, locked: true }));
      expectOk(
        await move(database.sql, {
          actorId: admin,
          topicId: topic.topicId,
          toForumId: staffForum,
        }),
      );
      expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: topic.topicId,
          sourceTopicIds: [source.topicId],
          title: "Merged log topic",
        }),
      );
      expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: splitSource.topicId,
          postIds: splitPosts,
          target: { kind: "new", forumId: forum, title: "Split log topic" },
        }),
      );

      const reasonId = expectOk(
        await saveReason(database.sql, {
          key: `log_reason_${Date.now()}`,
          points: 1,
          expiryDays: 30,
          labels: { en: "Log reason" },
          enabled: true,
        }),
      ).id;
      const warning = expectOk(
        await issueWarning(database.sql, {
          actorId: admin,
          memberId: target,
          reasonId,
          memberNote: "Log warning",
        }),
      );
      expectOk(
        await revokeWarning(database.sql, {
          actorId: admin,
          warningId: warning.warningId,
          reason: "Log revoke",
        }),
      );

      expectOk(
        await banMember(database.sql, {
          actorId: admin,
          memberId: target,
          reason: "Log ban",
        }),
      );
      expectOk(await unbanMember(database.sql, { actorId: admin, memberId: target }));

      const ipBan = expectOk(
        await banIp(database.sql, {
          actorId: admin,
          cidr: "198.51.100.0/24",
          reason: "Log IP ban",
        }),
      );
      expectOk(await removeIpBan(database.sql, { actorId: admin, id: ipBan.id }));

      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Log multimod ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "Logged multi-mod reply", authorId: null }],
        }),
      );
      expectOk(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: definition.id,
          topicId: splitSource.topicId,
        }),
      );

      const report = expectOk(
        await createReport(database.sql, {
          actorId: member,
          targetType: "member",
          targetId: target,
          reason: "spam",
          comment: "Log report",
        }),
      );
      expectOk(
        await updateReport(database.sql, {
          actorId: admin,
          reportId: report.reportId,
          action: { kind: "status", status: "resolved" },
        }),
      );

      // IP capture + audited lookup.
      await recordPostIp(database.sql, topic.postId, "198.51.100.7");
      const token = `log-staff-${crypto.randomUUID()}`;
      await database.sql`
        INSERT INTO core.sessions (
          member_id, kind, token_hash, reauth_at, last_seen_at, last_auth_at
        )
        VALUES (
          ${admin}, 'staff', ${hashToken(token)}, now() + interval '1 hour', now(), now()
        )
      `;
      const ipResponse = await openIpAccessResponse(
        database.sql,
        admin,
        new Request("http://staff.localhost/api/staff/ips/open", {
          method: "POST",
          headers: {
            cookie: `bl_staff=${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            purpose: "post_ip",
            resourceType: "post",
            resourceId: topic.postId,
          }),
        }),
      );
      expect(ipResponse.status).toBe(200);

      // PM report context view.
      const conversation = expectOk(
        await startConversation(database.sql, {
          actorId: member,
          title: "Log PM report",
          bodyMd: "Message one",
          recipientIds: [target],
        }),
      );
      expectOk(
        await replyToConversation(database.sql, {
          actorId: target,
          conversationId: conversation.conversationId,
          bodyMd: "Message two",
        }),
      );
      const messages = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversation.conversationId} ORDER BY id
      `) as Array<{ id: string }>;
      const pmReport = expectOk(
        await createReport(database.sql, {
          actorId: member,
          targetType: "pm",
          targetId: messages[1]?.id ?? "",
          reason: "abuse",
          comment: "",
        }),
      );
      expectOk(
        await readReportDetail(database.sql, {
          actorId: admin,
          reportId: pmReport.reportId,
        }),
      );

      const actions = await logActions(database);
      for (const action of [
        "post.approve",
        "post.reject",
        "post.delete",
        "post.restore",
        "topic.hard_delete",
        "post.edit",
        "topic.pin",
        "topic.lock",
        "topic.move",
        "topic.merge",
        "topic.split",
        "warning.issue",
        "warning.revoke",
        "member.ban",
        "member.unban",
        "ip.ban",
        "ip.remove",
        "multimod.apply",
        "report.status",
        "ip.lookup",
        "report.pm_access",
      ]) {
        expect(actions).toContain(action);
      }
      expect(actions).toContain("topic.split");

      const merged = await listModerationLog(database.sql, {
        actorId: admin,
        filters: { action: "topic.merge" },
      });
      expect(merged.entries[0]?.details).toMatchObject({
        destinationTopicId: topic.topicId,
        sourceTopicIds: [source.topicId],
      });

      const memberFiltered = await listModerationLog(database.sql, {
        actorId: admin,
        filters: { memberId: target },
      });
      expect(memberFiltered.entries.every((entry) => entry.memberId === target)).toBe(true);
      void tree;
    });
  }, 90_000);

  test("forum moderators see only their forum entries and the log is append-only", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const mod = await memberId(database, "forum-mod");
      const member = await memberId(database, "member-1");
      const tree = await loadForumTree(database.sql);
      const moderated = (await moderatedForums(database.sql, mod, null, tree)).map((f) => f.id);
      const forums = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
      `) as Array<{ id: string }>;
      const inScope = moderated[0];
      const outOfScope = forums.find((forum) => !moderated.includes(forum.id))?.id;

      if (inScope === undefined || outOfScope === undefined) {
        throw new Error("Missing scoped forums");
      }

      for (const forum of [inScope, outOfScope]) {
        const topic = expectOk(
          await startTopic(database.sql, {
            actorId: admin,
            forumId: forum,
            title: `Scoped log ${forum}`,
            bodyMd: "Body.",
          }),
        );
        expectOk(await pin(database.sql, { actorId: admin, topicId: topic.topicId, pinned: true }));
      }

      const scoped = await listModerationLog(database.sql, { actorId: mod });
      expect(scoped.allowed).toBe(true);
      expect(scoped.entries.length).toBeGreaterThan(0);
      expect(scoped.entries.every((entry) => entry.forumId === inScope)).toBe(true);
      const full = await listModerationLog(database.sql, { actorId: admin });
      expect(full.entries.some((entry) => entry.forumId === outOfScope)).toBe(true);
      expect(await can(database.sql, member, "acp.log")).toBe(false);

      const grants = (await database.sql`
        SELECT r,
          has_table_privilege(r, 'core.moderation_log', 'INSERT') AS can_insert,
          has_table_privilege(r, 'core.moderation_log', 'SELECT') AS can_select,
          has_table_privilege(r, 'core.moderation_log', 'UPDATE') AS can_update,
          has_table_privilege(r, 'core.moderation_log', 'DELETE') AS can_delete
        FROM unnest(ARRAY['user_app', 'user_api', 'staff_api', 'workers']) AS r
        ORDER BY r
      `) as Array<{
        r: string;
        can_insert: boolean;
        can_select: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>;
      expect(grants).toEqual([
        {
          r: "staff_api",
          can_insert: true,
          can_select: true,
          can_update: false,
          can_delete: false,
        },
        {
          r: "user_api",
          can_insert: true,
          can_select: true,
          can_update: false,
          can_delete: false,
        },
        {
          r: "user_app",
          can_insert: false,
          can_select: true,
          can_update: false,
          can_delete: false,
        },
        {
          r: "workers",
          can_insert: false,
          can_select: false,
          can_update: false,
          can_delete: false,
        },
      ]);
    });
  }, 60_000);
});
