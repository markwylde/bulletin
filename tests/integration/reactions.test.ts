import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  createTagVersions,
  GLOBAL_CACHE_TAGS,
  type RenderCache,
  type RenderStatus,
  readTagVersion,
} from "@bulletin/cache";
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
import {
  deleteReaction,
  listReactions,
  readReactionSummary,
  readReactors,
  reorderReaction,
  saveReaction,
  setReaction,
} from "@bulletin/domain/reactions";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { reactionMembersResponse, reactionSetResponse } from "../../apps/user-api/src/reactions.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderReactionBar } from "../../apps/user-app/src/reactions/fragment.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reactions" }, async (database) => {
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
  title = "Reaction target",
): Promise<{ topicId: string; postId: string }> {
  const author = await memberSession(database, authorSub);
  const forum = await forumId(database, forumSlug);
  const result = await startTopic(database.sql, {
    actorId: author.memberId,
    forumId: forum,
    title,
    bodyMd: "A post worth reacting to.",
  });

  if (!result.ok) {
    throw new Error(`Could not start the topic: ${result.code}`);
  }

  return { topicId: result.result.topicId, postId: result.result.postId };
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

integrationDescribe("reactions", () => {
  test("seeds the default set and adds, changes and removes one reaction per post", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const topic = await startedTopic(database, "member-2");
      const like = await reactionId(database, "like");
      const thanks = await reactionId(database, "thanks");

      expect((await listReactions(database.sql)).map((reaction) => reaction.key)).toEqual([
        "like",
        "thanks",
        "love",
        "laugh",
        "wow",
        "sad",
        "confused",
        "angry",
      ]);

      const added = await setReaction(database.sql, {
        actorId: member.memberId,
        postId: topic.postId,
        reactionId: like,
      });
      expect(added.ok).toBe(true);
      expect(added.ok ? added.result.mine : null).toBe(like);
      expect(added.ok ? added.result.summary : {}).toEqual({ [like]: 1 });

      // Changing replaces the previous reaction instead of adding a second one.
      const changed = await setReaction(database.sql, {
        actorId: member.memberId,
        postId: topic.postId,
        reactionId: thanks,
      });
      expect(changed.ok ? changed.result.summary : {}).toEqual({ [thanks]: 1 });
      expect(await readReactionSummary(database.sql, topic.postId)).toEqual({ [thanks]: 1 });

      const events = (await database.sql`
        SELECT payload_ids FROM core.events WHERE type = 'reaction.added' ORDER BY id
      `) as Array<{ payload_ids: unknown }>;
      expect(events).toHaveLength(2);
      const payload =
        typeof events[1]?.payload_ids === "string"
          ? (JSON.parse(events[1].payload_ids) as Record<string, string>)
          : (events[1]?.payload_ids as Record<string, string>);
      expect(payload).toMatchObject({
        reactionId: thanks,
        postId: topic.postId,
        topicId: topic.topicId,
        memberId: member.memberId,
      });

      const removed = await setReaction(database.sql, {
        actorId: member.memberId,
        postId: topic.postId,
        reactionId: null,
      });
      expect(removed.ok ? removed.result.mine : "unset").toBeNull();
      expect(removed.ok ? removed.result.summary : { missing: true }).toEqual({});
      expect(
        (await database.sql`SELECT 1 FROM core.post_reactions WHERE post_id = ${topic.postId}`)
          .length,
      ).toBe(0);
      // Removal is not a new reaction fact.
      expect(
        (await database.sql`SELECT 1 FROM core.events WHERE type = 'reaction.added'`).length,
      ).toBe(2);
    });
  }, 45_000);

  test("rejects own posts, reactions the member cannot use and unreadable forums", async () => {
    await withSeededDb(async (database) => {
      const author = await memberSession(database, "member-2");
      const member = await memberSession(database, "member-1");
      const own = await startedTopic(database, "member-2", "off-topic", "My own post");
      const like = await reactionId(database, "like");

      expect(
        await setReaction(database.sql, {
          actorId: author.memberId,
          postId: own.postId,
          reactionId: like,
        }),
      ).toEqual({ ok: false, code: "own_post" });

      expect(
        await setReaction(database.sql, {
          actorId: member.memberId,
          postId: own.postId,
          reactionId: "999999",
        }),
      ).toEqual({ ok: false, code: "invalid_reaction" });

      // The staff room is not readable by Members, so its posts are not either.
      const staffTopic = await startedTopic(database, "admin", "staff-room", "Staff only");
      expect(
        await setReaction(database.sql, {
          actorId: member.memberId,
          postId: staffTopic.postId,
          reactionId: like,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.can_react', 'false'::jsonb FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      const otherTopic = await startedTopic(database, "member-2", "off-topic", "No reacting");

      expect(
        await setReaction(database.sql, {
          actorId: member.memberId,
          postId: otherTopic.postId,
          reactionId: like,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
    });
  }, 45_000);

  test("lists who reacted to readers of the post only", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const topic = await startedTopic(database, "member-2");
      const like = await reactionId(database, "like");
      await setReaction(database.sql, {
        actorId: member.memberId,
        postId: topic.postId,
        reactionId: like,
      });

      const reactors = await readReactors(database.sql, topic.postId, like);
      expect(reactors).toEqual([{ id: member.memberId, displayName: member.displayName }]);

      const shared = await reactionMembersResponse(
        database.sql,
        null,
        topic.postId,
        new URL(`http://localhost/api/posts/${topic.postId}/reactions?reactionId=${like}`),
      );
      expect(shared.status).toBe(200);
      expect((await shared.json()) as unknown).toEqual({
        members: [{ id: member.memberId, name: "Regular Member One" }],
      });

      const staffTopic = await startedTopic(database, "admin", "staff-room", "Staff react");
      await setReaction(database.sql, {
        actorId: (await memberSession(database, "super-mod")).memberId,
        postId: staffTopic.postId,
        reactionId: like,
      });
      const denied = await reactionMembersResponse(
        database.sql,
        null,
        staffTopic.postId,
        new URL(`http://localhost/api/posts/${staffTopic.postId}/reactions?reactionId=${like}`),
      );
      expect(denied.status).toBe(404);
    });
  }, 45_000);

  test("who-reacted never reveals held or deleted posts to ordinary viewers", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const topic = await startedTopic(database, "member-2", "off-topic", "Held reactions");
      const like = await reactionId(database, "like");
      const url = new URL(
        `http://localhost/api/posts/${topic.postId}/reactions?reactionId=${like}`,
      );

      await database.sql`
        INSERT INTO core.post_reactions (post_id, member_id, reaction_id)
        VALUES (${topic.postId}, ${member.memberId}, ${like})
      `;

      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${topic.postId}
      `;
      expect((await reactionMembersResponse(database.sql, null, topic.postId, url)).status).toBe(
        404,
      );
      expect((await reactionMembersResponse(database.sql, member, topic.postId, url)).status).toBe(
        404,
      );
      expect(
        (await reactionMembersResponse(database.sql, moderator, topic.postId, url)).status,
      ).toBe(200);

      await database.sql`
        UPDATE core.posts SET visibility = 'soft_deleted' WHERE id = ${topic.postId}
      `;
      expect((await reactionMembersResponse(database.sql, member, topic.postId, url)).status).toBe(
        404,
      );
      expect(
        (await reactionMembersResponse(database.sql, moderator, topic.postId, url)).status,
      ).toBe(200);
    });
  }, 45_000);

  test("disabling a reaction hides the choice but keeps existing totals", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const topic = await startedTopic(database, "member-2");
      const confused = await reactionId(database, "confused");
      const stored = (await listReactions(database.sql)).find(
        (reaction) => reaction.id === confused,
      );

      if (stored === undefined) {
        throw new Error("Missing the confused reaction");
      }

      await setReaction(database.sql, {
        actorId: member.memberId,
        postId: topic.postId,
        reactionId: confused,
      });
      const saved = await saveReaction(database.sql, {
        id: stored.id,
        key: stored.key,
        icon: stored.icon,
        labelKey: "reaction.label.confused",
        weight: 0,
        position: stored.position,
        enabled: false,
      });
      expect(saved.ok).toBe(true);

      expect(
        await setReaction(database.sql, {
          actorId: (await memberSession(database, "member-fr")).memberId,
          postId: topic.postId,
          reactionId: confused,
        }),
      ).toEqual({ ok: false, code: "reaction_disabled" });

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const html = await renderReactionBar({
          sql: database.sql,
          cache: createRenderCache({ tags: versions }),
          postId: topic.postId,
          locale: "en",
          translate,
          canReact: true,
        });

        expect(html).toContain(`data-reaction-total="${confused}"`);
        expect(html).not.toContain(`data-reaction-pick="${confused}"`);
        expect(html).toMatch(new RegExp(`data-reaction-count="${confused}">1<`));
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("the API route maps reaction outcomes to permission-denial statuses", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const own = await startedTopic(database, "member-1", "off-topic", "My own API post");
      const other = await startedTopic(database, "member-2", "off-topic", "Their API post");
      const like = await reactionId(database, "like");

      const request = (body: unknown) =>
        new Request(`http://localhost/api/posts/${other.postId}/reactions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const added = await reactionSetResponse(
        database.sql,
        member,
        other.postId,
        request({ reactionId: like }),
      );
      expect(added.status).toBe(200);

      const removed = await reactionSetResponse(
        database.sql,
        member,
        other.postId,
        request({ reactionId: null }),
      );
      expect(removed.status).toBe(200);

      const ownPost = await reactionSetResponse(
        database.sql,
        member,
        own.postId,
        request({ reactionId: like }),
      );
      expect(ownPost.status).toBe(403);
      expect(await ownPost.json()).toEqual({ code: "own_post" });

      const invalid = await reactionSetResponse(
        database.sql,
        member,
        other.postId,
        request({ reactionId: "not-a-number" }),
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ code: "invalid_reaction" });

      const missing = await reactionSetResponse(
        database.sql,
        member,
        "987654",
        request({ reactionId: like }),
      );
      expect(missing.status).toBe(404);
    });
  }, 45_000);

  test("a reaction rebuilds only the reaction bar, never the post body block", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const topic = await startedTopic(database, "member-2", "off-topic", "Cached reaction topic");
      const like = await reactionId(database, "like");
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
            session: member,
            ref: `${topic.topicId}-cached-reaction-topic`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        await render();
        entries.length = 0;
        const warm = await render();
        expect(warm.kind).toBe("page");
        expect(warm.kind === "page" ? warm.cache : null).toBe("hit");
        expect(entries.every((entry) => entry.status === "hit")).toBe(true);

        const setVersion = await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.reactions);
        entries.length = 0;
        const reacted = await setReaction(database.sql, {
          actorId: member.memberId,
          postId: topic.postId,
          reactionId: like,
        });
        expect(reacted.ok).toBe(true);
        await versions.refresh();

        const after = await render();
        const statuses = new Map(entries.map((entry) => [entry.key, entry.status]));
        const postBlock = [...statuses.entries()].find(([key]) => key.startsWith("post-block:"));
        const reactionBar = [...statuses.entries()].find(([key]) =>
          key.startsWith("reaction-bar:"),
        );

        expect(after.kind).toBe("page");
        expect(after.kind === "page" ? after.cache : null).toBe("hit");
        expect(await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.reactions)).toBe(setVersion);
        expect(postBlock?.[1]).toBe("hit");
        expect(reactionBar?.[1]).toBe("miss");
        expect(after.kind === "page" ? after.html : "").toContain(`data-reaction-pick="${like}"`);
        expect(after.kind === "page" ? after.etag : null).not.toBe(
          warm.kind === "page" ? warm.etag : null,
        );
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("the staff set manager saves, reorders and refuses to delete a used reaction", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const topic = await startedTopic(database, "member-2");
      const before = await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.reactions);

      const created = await saveReaction(database.sql, {
        key: "party",
        icon: "🎉",
        labelKey: "reaction.label.love",
        weight: 1,
        position: 99,
        enabled: true,
      });
      expect(created.ok).toBe(true);

      const party = await reactionId(database, "party");
      expect(await readTagVersion(database.sql, GLOBAL_CACHE_TAGS.reactions)).not.toBe(before);

      // Creating an existing key must not silently change its weight; the edit path does that.
      expect(
        await saveReaction(database.sql, {
          key: "party",
          icon: "🎉",
          labelKey: "reaction.label.love",
          weight: -1,
          position: 99,
          enabled: true,
        }),
      ).toEqual({ ok: false, code: "duplicate_key" });
      expect(
        (await listReactions(database.sql)).find((reaction) => reaction.key === "party")?.weight,
      ).toBe(1);

      // Editing a reaction to a key another reaction already owns is refused.
      const thanks = await reactionId(database, "thanks");
      expect(
        await saveReaction(database.sql, {
          id: thanks,
          key: "party",
          icon: "🙏",
          labelKey: "reaction.label.thanks",
          weight: 0,
          position: 1,
          enabled: true,
        }),
      ).toEqual({ ok: false, code: "duplicate_key" });

      await reorderReaction(database.sql, party, "up");
      const ordered = (await listReactions(database.sql)).map((reaction) => reaction.key);
      expect(ordered.indexOf("party")).toBe(ordered.length - 2);

      await setReaction(database.sql, {
        actorId: member.memberId,
        postId: topic.postId,
        reactionId: party,
      });
      expect(await deleteReaction(database.sql, party)).toEqual({ ok: false, code: "in_use" });

      const unused = await saveReaction(database.sql, {
        key: "sparkle",
        icon: "✨",
        labelKey: "reaction.label.wow",
        weight: 0,
        position: 100,
        enabled: true,
      });
      expect(unused).toMatchObject({ ok: true });
      const sparkle = await reactionId(database, "sparkle");
      expect(sparkle).toBe(unused.ok ? unused.reactionId : "");
      expect(await deleteReaction(database.sql, sparkle)).toEqual({
        ok: true,
        reactionId: sparkle,
      });

      // Staff can leave several reactions at the form's default position 0; reordering must
      // still move them by normalising the whole order.
      const tiedA = await saveReaction(database.sql, {
        key: "tied_a",
        icon: "🅰️",
        labelKey: "reaction.label.love",
        weight: 0,
        position: 0,
        enabled: true,
      });
      const tiedB = await saveReaction(database.sql, {
        key: "tied_b",
        icon: "🅱️",
        labelKey: "reaction.label.love",
        weight: 0,
        position: 0,
        enabled: true,
      });
      expect(tiedA.ok && tiedB.ok).toBe(true);
      const tiedOrder = (await listReactions(database.sql)).map((reaction) => reaction.key);
      expect(tiedOrder.indexOf("tied_a")).toBeLessThan(tiedOrder.indexOf("tied_b"));

      await reorderReaction(database.sql, await reactionId(database, "tied_b"), "up");
      const reordered = (await listReactions(database.sql)).map((reaction) => reaction.key);
      expect(reordered.indexOf("tied_b")).toBeLessThan(reordered.indexOf("tied_a"));
    });
  }, 45_000);
});
