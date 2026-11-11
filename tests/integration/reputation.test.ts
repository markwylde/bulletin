import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  createTagVersions,
  memberTag,
  type RenderCache,
  type RenderStatus,
  readTagVersion,
} from "@bulletin/cache";
import { runReputationRecount } from "@bulletin/db/jobs";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  reactionsSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { readBoardSettings } from "@bulletin/domain/board";
import { can } from "@bulletin/domain/permissions";
import { listReactions, saveReaction, setReaction } from "@bulletin/domain/reactions";
import {
  DEFAULT_REPUTATION_LABEL_SCALE,
  giveReputation,
  listRecountRuns,
  readReputationTarget,
  readViewerVotes,
} from "@bulletin/domain/reputation";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { saveBoardSettings } from "../../apps/staff-api/src/board-settings.ts";
import { reputationGiveResponse } from "../../apps/user-api/src/reputation.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderMemberCards } from "../../apps/user-app/src/topics/fragments.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reputation" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        reactionsSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
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

async function startedTopic(
  database: TestDatabase,
  authorSub: string,
  forumSlug = "off-topic",
  title = "Reputation target",
): Promise<{ topicId: string; postId: string }> {
  const author = await memberSession(database, authorSub);
  const result = await startTopic(database.sql, {
    actorId: author.memberId,
    forumId: await forumId(database, forumSlug),
    title,
    bodyMd: "A post worth rating.",
  });

  if (!result.ok) {
    throw new Error(`Could not start the topic: ${result.code}`);
  }

  return { topicId: result.result.topicId, postId: result.result.postId };
}

async function setGroupSetting(
  database: TestDatabase,
  groupKey: string,
  key: string,
  value: boolean | number,
): Promise<void> {
  if (typeof value === "boolean") {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      SELECT id, ${key}, to_jsonb(${value}::boolean)
      FROM core.groups WHERE key = ${groupKey}
      ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    return;
  }

  await database.sql`
    INSERT INTO core.group_settings (group_id, key, value)
    SELECT id, ${key}, to_jsonb(${value}::int)
    FROM core.groups WHERE key = ${groupKey}
    ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

async function setReactionsLink(database: TestDatabase, enabled: boolean): Promise<void> {
  await database.sql`
    UPDATE core.board_settings SET reactions_affect_reputation = ${enabled} WHERE id = 1
  `;
}

async function reactionId(database: TestDatabase, key: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.reactions WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing reaction ${key}`);
  }

  return row.id;
}

async function entryFor(
  database: TestDatabase,
  postId: string,
  giverId: string,
): Promise<{ points: number; source: string } | null> {
  const [row] = (await database.sql`
    SELECT points, source FROM core.reputation_entries
    WHERE post_id = ${postId} AND giver_id = ${giverId}
  `) as Array<{ points: number; source: string }>;

  return row ?? null;
}

async function reputationOf(database: TestDatabase, memberId: string): Promise<number> {
  const [row] = (await database.sql`
    SELECT reputation FROM core.members WHERE id = ${memberId}
  `) as Array<{ reputation: number }>;

  return row?.reputation ?? 0;
}

function trackingCache(cache: RenderCache): {
  readonly cache: RenderCache;
  readonly entries: Array<{ readonly key: string; readonly status: RenderStatus }>;
} {
  const entries: Array<{ key: string; status: RenderStatus }> = [];

  return {
    entries,
    cache: {
      ...cache,
      async getOrRender(request) {
        const result = await cache.getOrRender(request);
        entries.push({ key: result.key, status: result.status });
        return result;
      },
    },
  };
}

integrationDescribe("reputation", () => {
  test("gives one point once per post and updates the total and event", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const author = await memberSession(database, "member-2");
      const topic = await startedTopic(database, "member-2");

      const first = await giveReputation(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        points: 1,
      });
      expect(first.ok).toBe(true);
      expect(first.ok ? first.result.total : null).toBe(1);
      expect(await reputationOf(database, author.memberId)).toBe(1);
      expect(await entryFor(database, topic.postId, giver.memberId)).toEqual({
        points: 1,
        source: "vote",
      });

      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: topic.postId,
          points: 1,
        }),
      ).toEqual({ ok: false, code: "already_given" });

      const events = (await database.sql`
        SELECT payload_ids FROM core.events WHERE type = 'reputation.given'
      `) as Array<{ payload_ids: unknown }>;
      expect(events).toHaveLength(1);
      const payload =
        typeof events[0]?.payload_ids === "string"
          ? (JSON.parse(events[0].payload_ids) as Record<string, string>)
          : (events[0]?.payload_ids as Record<string, string>);
      expect(payload).toMatchObject({
        postId: topic.postId,
        giverId: giver.memberId,
        receiverId: author.memberId,
      });
    });
  }, 45_000);

  test("enforces giving permissions, the minimum post count and the daily allowance", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const first = await startedTopic(database, "member-2", "off-topic", "First target");
      const second = await startedTopic(database, "member-2", "off-topic", "Second target");

      await setGroupSetting(database, "members", "posting.can_give_reputation", false);
      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: first.postId,
          points: 1,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      await setGroupSetting(database, "members", "posting.can_give_reputation", true);

      await setGroupSetting(database, "members", "posting.reputation_min_posts", 10);
      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: first.postId,
          points: 1,
        }),
      ).toEqual({ ok: false, code: "min_posts", minPosts: 10 });
      await database.sql`
        UPDATE core.members SET post_count = 10 WHERE id = ${giver.memberId}
      `;

      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: first.postId,
          points: -1,
        }),
      ).toEqual({ ok: false, code: "negative_not_allowed" });
      await setGroupSetting(database, "members", "posting.can_give_negative_reputation", true);

      await setGroupSetting(database, "members", "posting.reputation_daily_limit", 1);
      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: first.postId,
          points: -1,
        }).then((result) => (result.ok ? null : result.code)),
      ).toBeNull();

      const limited = await giveReputation(database.sql, {
        actorId: giver.memberId,
        postId: second.postId,
        points: 1,
      });
      expect(limited.ok).toBe(false);

      if (!limited.ok && limited.code === "daily_limit") {
        expect(limited.resetsAt).toBeInstanceOf(Date);
        expect((limited.resetsAt?.getTime() ?? 0) > Date.now()).toBe(true);
      } else {
        throw new Error(`Expected the daily limit, got ${JSON.stringify(limited)}`);
      }
    });
  }, 45_000);

  test("refuses own posts, unreadable posts and posts whose author opts out", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const own = await startedTopic(database, "member-1", "off-topic", "My own rating");
      const staff = await startedTopic(database, "admin", "staff-room", "Staff target");

      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: own.postId,
          points: 1,
        }),
      ).toEqual({ ok: false, code: "own_post" });

      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: staff.postId,
          points: 1,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      await setGroupSetting(database, "administrators", "posting.cannot_receive_reputation", true);
      const adminPost = await startedTopic(database, "admin", "off-topic", "Admin target");
      const admin = await memberSession(database, "admin");

      expect(
        await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: adminPost.postId,
          points: 1,
        }),
      ).toEqual({ ok: false, code: "cannot_receive" });
      expect(await reputationOf(database, admin.memberId)).toBe(0);
    });
  }, 45_000);

  test("links reactions to reputation and rebuilds them when the toggle changes", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const author = await memberSession(database, "member-2");
      const topic = await startedTopic(database, "member-2", "off-topic", "Linked reaction");
      const like = (await listReactions(database.sql)).find((reaction) => reaction.key === "like");
      const thanks = (await listReactions(database.sql)).find(
        (reaction) => reaction.key === "thanks",
      );

      if (like === undefined || thanks === undefined) {
        throw new Error("Missing seeded reactions");
      }

      await saveReaction(database.sql, {
        id: like.id,
        key: like.key,
        icon: like.icon,
        labelKey: "reaction.label.like",
        weight: 1,
        position: like.position,
        enabled: true,
      });
      await saveReaction(database.sql, {
        id: thanks.id,
        key: thanks.key,
        icon: thanks.icon,
        labelKey: "reaction.label.thanks",
        weight: -1,
        position: thanks.position,
        enabled: true,
      });
      await setReactionsLink(database, true);

      await setReaction(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        reactionId: like.id,
      });
      expect(await entryFor(database, topic.postId, giver.memberId)).toEqual({
        points: 1,
        source: "reaction",
      });
      expect(await reputationOf(database, author.memberId)).toBe(1);

      await setReaction(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        reactionId: thanks.id,
      });
      expect(await entryFor(database, topic.postId, giver.memberId)).toEqual({
        points: -1,
        source: "reaction",
      });
      expect(await reputationOf(database, author.memberId)).toBe(-1);

      await setReaction(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        reactionId: null,
      });
      expect(await entryFor(database, topic.postId, giver.memberId)).toBeNull();
      expect(await reputationOf(database, author.memberId)).toBe(0);

      // Turning the link off removes reaction entries even before the recount job runs.
      await setReaction(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        reactionId: like.id,
      });
      expect(await reputationOf(database, author.memberId)).toBe(1);
      await setReactionsLink(database, false);
      const off = await runReputationRecount(database.sql);
      expect(off.changed).toBe(1);
      expect(await entryFor(database, topic.postId, giver.memberId)).toBeNull();
      expect(await reputationOf(database, author.memberId)).toBe(0);

      // Turning it back on backfills existing reactions.
      await setReactionsLink(database, true);
      const on = await runReputationRecount(database.sql);
      expect(on.changed).toBe(1);
      expect(await entryFor(database, topic.postId, giver.memberId)).toEqual({
        points: 1,
        source: "reaction",
      });
      expect(await reputationOf(database, author.memberId)).toBe(1);
    });
  }, 60_000);

  test("the board toggle records a recount request for the worker", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberSession(database, "admin");
      const settings = await readBoardSettings(database.sql);
      const result = await saveBoardSettings(database.sql, admin.memberId, {
        ...settings,
        reactionsAffectReputation: true,
      });
      expect(result.ok).toBe(true);

      const events = (await database.sql`
        SELECT payload_ids FROM core.events WHERE type = 'reputation.recount.requested'
      `) as Array<{ payload_ids: unknown }>;
      expect(events).toHaveLength(1);
      const payload =
        typeof events[0]?.payload_ids === "string"
          ? (JSON.parse(events[0].payload_ids) as Record<string, string>)
          : (events[0]?.payload_ids as Record<string, string>);
      expect(payload).toEqual({ requestedById: admin.memberId });
    });
  }, 45_000);

  test("a reputation change rebuilds the member card, not the post block or the page", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const topic = await startedTopic(database, "member-2", "off-topic", "Cached reputation");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const inner = createRenderCache({ tags: versions });
        const { cache, entries } = trackingCache(inner);
        const render = () =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: giver,
            ref: `${topic.topicId}-cached-reputation`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        await render();
        entries.length = 0;
        const warm = await render();
        expect(warm.kind === "page" ? warm.cache : null).toBe("hit");
        expect(entries.every((entry) => entry.status === "hit")).toBe(true);

        entries.length = 0;
        const given = await giveReputation(database.sql, {
          actorId: giver.memberId,
          postId: topic.postId,
          points: 1,
        });
        expect(given.ok).toBe(true);
        await versions.refresh();

        const after = await render();
        const statuses = new Map(entries.map((entry) => [entry.key, entry.status]));
        const postBlock = [...statuses.entries()].find(([key]) => key.startsWith("post-block:"));
        const card = [...statuses.entries()].find(([key]) => key.startsWith("member-card:"));

        expect(after.kind === "page" ? after.cache : null).toBe("hit");
        expect(postBlock?.[1]).toBe("hit");
        expect(card?.[1]).toBe("miss");
        expect(after.kind === "page" ? after.html : "").toMatch(/data-reputation-count="\d+">1</);
        expect(after.kind === "page" ? after.etag : null).not.toBe(
          warm.kind === "page" ? warm.etag : null,
        );
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("the card labels reputation from the board scale and hides when switched off", async () => {
    await withSeededDb(async (database) => {
      const author = await memberSession(database, "member-2");
      await database.sql`
        UPDATE core.members SET reputation = 120 WHERE id = ${author.memberId}
      `;
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const html = (
          await renderMemberCards(database.sql, cache, [author.memberId], "en", translate, true, {
            display: true,
            scale: DEFAULT_REPUTATION_LABEL_SCALE,
          })
        ).get(author.memberId);

        expect(html).toContain("Respected");
        expect(html).toMatch(/data-reputation-count="\d+">120</);

        const hidden = (
          await renderMemberCards(database.sql, cache, [author.memberId], "en", translate, true, {
            display: false,
            scale: DEFAULT_REPUTATION_LABEL_SCALE,
          })
        ).get(author.memberId);
        expect(hidden).not.toContain("data-reputation-count");
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("reputation is a promotion criterion and giving points evaluates it", async () => {
    await withSeededDb(async (database) => {
      const author = await memberSession(database, "member-2");
      const topic = await startedTopic(database, "member-2", "off-topic", "Promotion target");
      await database.sql`
        INSERT INTO core.promotion_rules (from_group_id, to_group_id, criteria, position, enabled)
        SELECT m.id, r.id, '{"reputation": 5}'::jsonb, 0, true
        FROM core.groups m, core.groups r
        WHERE m.key = 'members' AND r.key = 'regulars'
      `;

      const givers = await Promise.all(
        ["member-1", "member-fr", "member-es", "admin", "super-mod"].map((sub) =>
          memberSession(database, sub),
        ),
      );

      for (const giver of givers) {
        const response = await reputationGiveResponse(
          database.sql,
          giver,
          topic.postId,
          new Request(`http://localhost/api/posts/${topic.postId}/reputation`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ points: 1 }),
          }),
        );
        expect(response.status).toBe(200);
      }

      expect(await reputationOf(database, author.memberId)).toBe(5);
      const [group] = (await database.sql`
        SELECT g.key
        FROM core.member_groups mg
        JOIN core.groups g ON g.id = mg.group_id
        WHERE mg.member_id = ${author.memberId} AND mg.is_primary
      `) as Array<{ key: string }>;
      expect(group?.key).toBe("regulars");
      expect(
        (
          await database.sql`
            SELECT 1 FROM core.events WHERE type = 'member.promoted'
          `
        ).length,
      ).toBe(1);
    });
  }, 60_000);

  test("editing a reaction weight requests a recount and refreshes the card", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberSession(database, "admin");
      const giver = await memberSession(database, "member-1");
      const author = await memberSession(database, "member-2");
      const topic = await startedTopic(database, "member-2", "off-topic", "Weight change");
      const like = (await listReactions(database.sql)).find((reaction) => reaction.key === "like");

      if (like === undefined) {
        throw new Error("Missing the like reaction");
      }

      await setReactionsLink(database, true);
      await saveReaction(database.sql, {
        id: like.id,
        key: like.key,
        icon: like.icon,
        labelKey: "reaction.label.like",
        weight: 1,
        position: like.position,
        enabled: true,
      });
      await setReaction(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        reactionId: like.id,
      });
      expect(await reputationOf(database, author.memberId)).toBe(1);

      const cardVersion = await readTagVersion(database.sql, memberTag(author.memberId));
      const saved = await saveReaction(
        database.sql,
        {
          id: like.id,
          key: like.key,
          icon: like.icon,
          labelKey: "reaction.label.like",
          weight: -1,
          position: like.position,
          enabled: true,
        },
        { requestedById: admin.memberId },
      );
      expect(saved.ok).toBe(true);

      const events = (await database.sql`
        SELECT payload_ids FROM core.events WHERE type = 'reputation.recount.requested'
      `) as Array<{ payload_ids: unknown }>;
      expect(events).toHaveLength(1);
      const payload =
        typeof events[0]?.payload_ids === "string"
          ? (JSON.parse(events[0].payload_ids) as Record<string, string>)
          : (events[0]?.payload_ids as Record<string, string>);
      expect(payload).toEqual({ requestedById: admin.memberId });

      await runReputationRecount(database.sql, { reason: "weight-change" });

      expect(await entryFor(database, topic.postId, giver.memberId)).toEqual({
        points: -1,
        source: "reaction",
      });
      expect(await reputationOf(database, author.memberId)).toBe(-1);
      expect(await readTagVersion(database.sql, memberTag(author.memberId))).not.toBe(cardVersion);
    });
  }, 60_000);

  test("a recount waits for an in-flight vote and includes it", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const author = await memberSession(database, "member-2");
      const topic = await startedTopic(database, "member-2", "off-topic", "Concurrent recount");
      const other = new SQL(database.url);

      let signalStarted: () => void = () => undefined;
      let releaseVote: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseVote = resolve;
      });

      try {
        const vote = other.begin(async (tx) => {
          await tx`
            INSERT INTO core.reputation_entries (post_id, giver_id, receiver_id, points, source)
            VALUES (${topic.postId}, ${giver.memberId}, ${author.memberId}, 1, 'vote')
          `;
          await tx`
            UPDATE core.members SET reputation = reputation + 1 WHERE id = ${author.memberId}
          `;
          signalStarted();
          await gate;
        });

        await started;
        const recount = runReputationRecount(database.sql, { reason: "concurrent" });
        await Bun.sleep(150);
        releaseVote();
        await vote;
        const result = await recount;

        expect(result.done).toBe(true);
        expect(await reputationOf(database, author.memberId)).toBe(1);
      } finally {
        await other.close();
      }
    });
  }, 60_000);

  test("a recount resumes from its cursor, reports progress and is idempotent", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const author = await memberSession(database, "member-2");
      const topic = await startedTopic(database, "member-2", "off-topic", "Resumable recount");
      await giveReputation(database.sql, {
        actorId: giver.memberId,
        postId: topic.postId,
        points: 1,
      });

      const first = await runReputationRecount(database.sql, {
        reason: "retry-test",
        batchSize: 1,
        maxBatches: 1,
      });
      expect(first.done).toBe(false);
      expect(first.processed).toBe(1);
      expect(first.total).toBeGreaterThan(1);

      const running = (await listRecountRuns(database.sql, 5)).find(
        (run) => run.status === "running",
      );
      expect(running).toMatchObject({ processedMembers: 1, rebuiltAt: expect.any(Date) });

      const second = await runReputationRecount(database.sql, { reason: "retry-test" });
      expect(second.done).toBe(true);
      expect(second.processed).toBe(second.total);

      const finished = (await listRecountRuns(database.sql, 5)).find(
        (run) => run.id === second.runId,
      );
      expect(finished).toMatchObject({
        status: "done",
        processedMembers: second.total,
        changedMembers: expect.any(Number),
      });
      expect(await reputationOf(database, author.memberId)).toBe(1);

      // A fresh recount after completion is a new run and leaves correct totals untouched.
      const third = await runReputationRecount(database.sql, { reason: "retry-test" });
      expect(third.runId).not.toBe(second.runId);
      expect(third.done).toBe(true);
      expect(await reputationOf(database, author.memberId)).toBe(1);
    });
  }, 60_000);

  test("reaction and reputation capabilities resolve through can()", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");

      expect(await can(database.sql, member.memberId, "react")).toBe(true);
      expect(await can(database.sql, member.memberId, "give_reputation")).toBe(true);
      expect(await can(database.sql, member.memberId, "give_negative_reputation")).toBe(false);
      expect(await can(database.sql, member.memberId, "receive_reputation")).toBe(true);

      await setGroupSetting(database, "members", "posting.can_react", false);
      await setGroupSetting(database, "members", "posting.can_give_reputation", false);
      await setGroupSetting(database, "members", "posting.can_give_negative_reputation", true);
      await setGroupSetting(database, "members", "posting.cannot_receive_reputation", true);

      expect(await can(database.sql, member.memberId, "react")).toBe(false);
      expect(await can(database.sql, member.memberId, "give_reputation")).toBe(false);
      expect(await can(database.sql, member.memberId, "give_negative_reputation")).toBe(true);
      expect(await can(database.sql, member.memberId, "receive_reputation")).toBe(false);
    });
  }, 45_000);

  test("the viewer vote state and the target are read for the overlay and API", async () => {
    await withSeededDb(async (database) => {
      const giver = await memberSession(database, "member-1");
      const own = await startedTopic(database, "member-1", "off-topic", "Overlay own");
      const other = await startedTopic(database, "member-2", "off-topic", "Overlay other");
      await giveReputation(database.sql, {
        actorId: giver.memberId,
        postId: other.postId,
        points: 1,
      });

      expect(
        await readViewerVotes(database.sql, giver.memberId, [own.postId, other.postId]),
      ).toEqual([
        { postId: own.postId, points: null, own: true },
        { postId: other.postId, points: 1, own: false },
      ]);
      expect(await readReputationTarget(database.sql, other.postId)).toMatchObject({
        postId: other.postId,
        authorId: expect.any(String),
      });
    });
  }, 45_000);
});
