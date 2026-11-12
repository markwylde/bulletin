import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { ensureCurrentRendering, replaceWordsInText } from "@bulletin/content";
import { postRerenderSource, runContentRerenderJob } from "@bulletin/db/jobs";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  deleteFilterWord,
  loadReplaceWords,
  readFilterSettings,
  saveFilterDomain,
  saveFilterSettings,
  saveFilterWord,
} from "@bulletin/domain/filters";
import {
  editPost,
  move,
  readTopic,
  readTopicPostPage,
  reply,
  softDelete,
  startTopic,
} from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "filters" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
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

async function setMemberSetting(
  database: TestDatabase,
  groupKey: string,
  key: string,
  value: unknown,
): Promise<void> {
  await database.sql`
    INSERT INTO core.group_settings (group_id, key, value)
    SELECT id, ${key}, (${JSON.stringify(value)}::text)::jsonb
    FROM core.groups WHERE key = ${groupKey}
    ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

async function bodyWord(
  database: TestDatabase,
  postId: string,
): Promise<{
  readonly md: string;
  readonly html: string;
  readonly version: number;
}> {
  const [row] = (await database.sql`
    SELECT body_md, body_html, render_version FROM core.posts WHERE id = ${postId}
  `) as Array<{ body_md: string; body_html: string; render_version: number }>;

  if (row === undefined) {
    throw new Error("Missing post");
  }

  return { md: row.body_md, html: row.body_html, version: row.render_version };
}

integrationDescribe("content filters", () => {
  test("blocks configured words in titles and bodies while whole/any matching works", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      expectOk(
        await saveFilterWord(database.sql, {
          word: "badword",
          mode: "block",
          matchMode: "whole",
          enabled: true,
        }),
      );
      expectOk(
        await saveFilterWord(database.sql, {
          word: "sneaky",
          mode: "block",
          matchMode: "any",
          enabled: true,
        }),
      );

      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "A badword title",
          bodyMd: "Fine body.",
        }),
      ).toEqual({ ok: false, code: "blocked_word" });

      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "A clean title",
          bodyMd: "This has a badword in it.",
        }),
      ).toEqual({ ok: false, code: "blocked_word" });

      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "A clean title",
          bodyMd: "This is sneakyspam.",
        }),
      ).toEqual({ ok: false, code: "blocked_word" });
    });
  }, 60_000);

  test("replaces words on display, keeps stored source and applies later additions on read", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      expectOk(
        await saveFilterWord(database.sql, {
          word: "damn",
          mode: "replace",
          replacement: "****",
          matchMode: "whole",
          enabled: true,
        }),
      );
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Replace this later",
          bodyMd: "A damn post with crap in it.",
        }),
      );
      const first = await bodyWord(database, topic.postId);
      expect(first.md).toBe("A damn post with crap in it.");
      expect(first.html).toContain("****");
      expect(first.html).not.toContain("damn");
      expect(first.html).toContain("crap");
      expect(first.version).toBeGreaterThan(3_000_000);

      const before = await readFilterSettings(database.sql);
      expectOk(
        await saveFilterWord(database.sql, {
          word: "crap",
          mode: "replace",
          replacement: "[redacted]",
          matchMode: "any",
          enabled: true,
        }),
      );
      const after = await readFilterSettings(database.sql);
      expect(Number(after.version)).toBeGreaterThan(Number(before.version));

      const session = await memberSession(database, "member-1");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const page = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session,
          ref: `${topic.topicId}-replace-this-later`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        expect(page.kind).toBe("page");
        const html = page.kind === "page" ? page.html : "";
        expect(html).toContain("[redacted]");
        expect(html).not.toContain("crap");
        expect(html).toContain("****");
        expect(html).not.toContain("damn");
        expect((await bodyWord(database, topic.postId)).md).toBe("A damn post with crap in it.");
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("blocks substring-only rules on topic creation, replies and edits", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      await database.sql`DELETE FROM core.filter_words WHERE mode = 'block'`;
      expectOk(
        await saveFilterWord(database.sql, {
          word: "forbidden",
          mode: "block",
          matchMode: "any",
          enabled: true,
        }),
      );

      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Substring blocked topic",
          bodyMd: "xxforbiddenxx",
        }),
      ).toEqual({ ok: false, code: "blocked_word" });

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Clean topic",
          bodyMd: "This body is clean.",
        }),
      );
      expect(
        await reply(database.sql, {
          actorId: member,
          topicId: topic.topicId,
          bodyMd: "xxforbiddenxx",
        }),
      ).toEqual({ ok: false, code: "blocked_word" });
      expect(
        await editPost(database.sql, {
          actorId: member,
          postId: topic.postId,
          bodyMd: "xxforbiddenxx",
        }),
      ).toEqual({ ok: false, code: "blocked_word" });
    });
  }, 60_000);

  test("rebuilds posts from Markdown when a replacement changes or is removed", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const rule = await saveFilterWord(database.sql, {
        word: "OLDMARK",
        mode: "replace",
        replacement: "FIRSTMARK",
        matchMode: "any",
        enabled: true,
      });

      if (!rule.ok) {
        throw new Error(`Could not save the filter word: ${rule.code}`);
      }
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Replacement rerender",
          bodyMd: "Hello OLDMARK.",
        }),
      );
      const rendered = async () =>
        (
          (await database.sql`
            SELECT body_html FROM core.posts WHERE id = ${topic.postId}
          `) as Array<{ body_html: string }>
        )[0]?.body_html ?? "";
      expect(await rendered()).toContain("FIRSTMARK");

      const changedRule = await saveFilterWord(database.sql, {
        id: rule.id,
        word: "OLDMARK",
        mode: "replace",
        replacement: "SECONDMARK",
        matchMode: "any",
        enabled: true,
      });
      expect(changedRule.ok).toBe(true);
      await runContentRerenderJob(database.sql, {
        sources: [postRerenderSource],
        batchSize: 5_000,
      });
      expect(await rendered()).toContain("SECONDMARK");
      expect(await rendered()).not.toContain("FIRSTMARK");

      await deleteFilterWord(database.sql, rule.id);
      await runContentRerenderJob(database.sql, {
        sources: [postRerenderSource],
        batchSize: 5_000,
      });
      expect(await rendered()).toContain("OLDMARK");
      expect(await rendered()).not.toContain("SECONDMARK");
    });
  }, 60_000);

  test("a re-render keeps quote snapshots of a deleted source", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");
      const forum = await forumId(database, "off-topic");
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Deleted quote source",
          bodyMd: "The quoted source body.",
        }),
      );
      const quoting = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Quoting post",
          bodyMd: `:::quote{source="post:${source.postId}"}\nquoted\n:::\n\nHello OLDMARK.`,
        }),
      );
      const stored = async () =>
        (
          (await database.sql`
            SELECT body_html, quoted_forum_ids::text[] AS quoted_forum_ids
            FROM core.posts WHERE id = ${quoting.postId}
          `) as Array<{ body_html: string; quoted_forum_ids: string[] }>
        )[0];

      const before = await stored();
      const snapshotId = /data-snapshot="(\d+)"/.exec(before?.body_html ?? "")?.[1];
      expect(snapshotId).toBeString();
      expect(before?.quoted_forum_ids).toEqual([forum]);

      expectOk(await softDelete(database.sql, { actorId: admin, postId: source.postId }));
      expectOk(
        await saveFilterWord(database.sql, {
          word: "OLDMARK",
          mode: "replace",
          replacement: "REBUILT",
          matchMode: "any",
          enabled: true,
        }),
      );

      const result = await runContentRerenderJob(database.sql, {
        sources: [postRerenderSource],
        batchSize: 5_000,
      });
      expect(result.rerendered).toBeGreaterThan(0);

      const after = await stored();
      expect(after?.body_html).toContain("REBUILT");
      expect(after?.body_html).toContain(`data-snapshot="${snapshotId}"`);
      expect(after?.quoted_forum_ids).toEqual([forum]);

      const snapshots = (await database.sql`
        SELECT count(*)::int AS count FROM core.quote_snapshots
        WHERE source_kind = 'post' AND source_id = ${source.postId}
      `) as Array<{ count: number }>;
      expect(snapshots[0]?.count).toBe(1);
    });
  }, 60_000);

  test("a re-render keeps quote snapshots when the source is no longer readable", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");
      const forum = await forumId(database, "off-topic");
      const staffForum = await forumId(database, "staff-room");
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Moved quote source",
          bodyMd: "The quoted source body.",
        }),
      );
      const quoting = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Quoting post with revoked access",
          bodyMd: `:::quote{source="post:${source.postId}"}\nquoted\n:::\n\nHello OLDMARK.`,
        }),
      );
      const snapshotId = /data-snapshot="(\d+)"/.exec(
        (
          (await database.sql`
            SELECT body_html FROM core.posts WHERE id = ${quoting.postId}
          `) as Array<{ body_html: string }>
        )[0]?.body_html ?? "",
      )?.[1];
      expect(snapshotId).toBeString();

      expectOk(
        await move(database.sql, {
          actorId: admin,
          topicId: source.topicId,
          toForumId: staffForum,
        }),
      );
      expectOk(
        await saveFilterWord(database.sql, {
          word: "OLDMARK",
          mode: "replace",
          replacement: "REBUILT",
          matchMode: "any",
          enabled: true,
        }),
      );

      const result = await runContentRerenderJob(database.sql, {
        sources: [postRerenderSource],
        batchSize: 5_000,
      });
      expect(result.rerendered).toBeGreaterThan(0);

      const [after] = (await database.sql`
        SELECT body_html, quoted_forum_ids::text[] AS quoted_forum_ids
        FROM core.posts WHERE id = ${quoting.postId}
      `) as Array<{ body_html: string; quoted_forum_ids: string[] }>;
      expect(after?.body_html).toContain("REBUILT");
      expect(after?.body_html).toContain(`data-snapshot="${snapshotId}"`);
      expect(after?.quoted_forum_ids).toEqual([forum]);
    });
  }, 60_000);

  test("a changed or removed replacement applies on the next view before jobs run", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const viewer = await memberSession(database, "member-1");
      const forum = await forumId(database, "off-topic");
      const rule = await saveFilterWord(database.sql, {
        word: "OLDMARK",
        mode: "replace",
        replacement: "FIRSTMARK",
        matchMode: "any",
        enabled: true,
      });

      if (!rule.ok) {
        throw new Error(`Could not save the filter word: ${rule.code}`);
      }

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Immediate replacement view",
          bodyMd: "Hello OLDMARK.",
        }),
      );
      const [storedUnfiltered] = (await database.sql`
        SELECT body_html_unfiltered FROM core.posts WHERE id = ${topic.postId}
      `) as Array<{ body_html_unfiltered: string | null }>;
      expect(storedUnfiltered?.body_html_unfiltered).toContain("OLDMARK");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const view = async () => {
          await versions.refresh();
          const page = await renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: viewer,
            ref: `${topic.topicId}-immediate-replacement-view`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache: createRenderCache({ tags: versions }),
            tagVersions: versions,
          });

          if (page.kind !== "page") {
            throw new Error("Expected a topic page");
          }

          return page.html;
        };

        expect(await view()).toContain("FIRSTMARK");

        const changed = await saveFilterWord(database.sql, {
          id: rule.id,
          word: "OLDMARK",
          mode: "replace",
          replacement: "SECONDMARK",
          matchMode: "any",
          enabled: true,
        });
        expect(changed.ok).toBe(true);
        const words = await loadReplaceWords(database.sql);
        expect(words.rules.find((word) => word.word === "OLDMARK")?.replacement).toBe("SECONDMARK");
        const pageRows = await readTopicPostPage(database.sql, {
          topicId: topic.topicId,
          limit: 10,
          offset: 0,
          seeUnapproved: true,
          seeDeleted: true,
        });
        const row = pageRows.rows[0];
        expect(row?.bodyHtmlUnfiltered).toContain("OLDMARK");

        if (row === undefined) {
          throw new Error("Missing the post row");
        }

        const direct = await ensureCurrentRendering(
          { ...row, bodyHtml: row.bodyHtmlUnfiltered ?? row.bodyHtml },
          {
            profile: "post",
            replaceWords: words,
            versions: { renderVersion: -1, sanitiserVersion: -1 },
          },
        );
        expect(direct.bodyHtml).toContain("SECONDMARK");
        const second = await view();
        expect(second).toContain("SECONDMARK");
        expect(second).not.toContain("FIRSTMARK");

        await deleteFilterWord(database.sql, rule.id);
        const removed = await view();
        expect(removed).toContain("OLDMARK");
        expect(removed).not.toContain("SECONDMARK");
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("applies replacement rules to topic author cards and signatures", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-2");
      const viewer = await memberSession(database, "member-1");
      const forum = await forumId(database, "off-topic");
      expectOk(
        await saveFilterWord(database.sql, {
          word: "bad",
          mode: "replace",
          replacement: "good",
          matchMode: "any",
          enabled: true,
        }),
      );
      await database.sql`
        UPDATE core.members
        SET display_name = 'badname', custom_title = 'badtitle',
          signature_html = '<p>bad signature</p>', signature_updated_at = now()
        WHERE id = ${member}
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Filtered author card",
          bodyMd: "A clean body.",
        }),
      );
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const page = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: viewer,
          ref: `${topic.topicId}-filtered-author-card`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache: createRenderCache({ tags: versions }),
          tagVersions: versions,
        });
        expect(page.kind).toBe("page");
        const html = page.kind === "page" ? page.html : "";
        expect(html).toContain("goodname");
        expect(html).toContain("goodtitle");
        expect(html).toContain("good signature");
        expect(html).not.toContain("badname");
        expect(html).not.toContain("badtitle");
        expect(html).not.toContain("bad signature");
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("carries whole-word and substring matching into the replacement transform", async () => {
    await withSeededDb(async (database) => {
      expectOk(
        await saveFilterWord(database.sql, {
          word: "bad",
          mode: "replace",
          replacement: "@@@",
          matchMode: "whole",
          enabled: true,
        }),
      );
      expectOk(
        await saveFilterWord(database.sql, {
          word: "ass",
          mode: "replace",
          replacement: "#",
          matchMode: "any",
          enabled: true,
        }),
      );

      const words = await loadReplaceWords(database.sql);
      expect(words.rules).toEqual(
        expect.arrayContaining([
          { word: "bad", replacement: "@@@", matchMode: "whole" },
          { word: "ass", replacement: "#", matchMode: "any" },
        ]),
      );
      expect(replaceWordsInText("bad badge badly class", words)).toBe("@@@ badge badly cl#");
    });
  }, 60_000);

  test("edits apply link limits and anti-spam rules", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      await setMemberSetting(database, "members", "posting.link_limit", 1);
      await setMemberSetting(database, "members", "posting.link_limit_action", "hold");
      const held = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Edited into a link hold",
          bodyMd: "A clean opening.",
        }),
      );
      expectOk(
        await editPost(database.sql, {
          actorId: member,
          postId: held.postId,
          bodyMd: "[one](https://one.example) [two](https://two.example)",
        }),
      );
      const [heldRow] = (await database.sql`
        SELECT p.visibility, p.hold_reason, t.visibility AS topic_visibility
        FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
        WHERE p.id = ${held.postId}
      `) as Array<{
        visibility: string;
        hold_reason: string | null;
        topic_visibility: string;
      }>;
      expect(heldRow).toEqual({
        visibility: "unapproved",
        hold_reason: "link_limit",
        topic_visibility: "unapproved",
      });

      await setMemberSetting(database, "members", "posting.link_limit_action", "reject");
      const rejected = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Edited into a link rejection",
          bodyMd: "Another clean opening.",
        }),
      );
      expect(
        await editPost(database.sql, {
          actorId: member,
          postId: rejected.postId,
          bodyMd: "[one](https://one.example) [two](https://two.example)",
        }),
      ).toEqual({ ok: false, code: "too_many_links" });

      await setMemberSetting(database, "members", "posting.link_limit", 20);
      expectOk(await saveFilterDomain(database.sql, { domain: "evil.example", enabled: true }));
      const spamTopic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Edited into a spam hold",
          bodyMd: "Spam clean opening.",
        }),
      );
      const spamReply = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: spamTopic.topicId,
          bodyMd: "A clean reply.",
        }),
      );
      expectOk(
        await editPost(database.sql, {
          actorId: member,
          postId: spamReply.postId,
          bodyMd: "[click](https://evil.example/path)",
        }),
      );
      const [spamRow] = (await database.sql`
        SELECT visibility, hold_reason FROM core.posts WHERE id = ${spamReply.postId}
      `) as Array<{ visibility: string; hold_reason: string | null }>;
      expect(spamRow).toEqual({ visibility: "unapproved", hold_reason: "domain_blocklist" });
    });
  }, 60_000);

  test("holds new-member link-heavy posts and exempts a staff group", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "new-member");
      const moderator = await memberId(database, "super-mod");
      const forum = await forumId(database, "off-topic");
      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${member}`;
      await setMemberSetting(database, "members", "posting.link_limit", 1);
      await setMemberSetting(database, "members", "posting.link_limit_min_posts", 10);
      await setMemberSetting(database, "members", "posting.link_limit_action", "hold");
      await setMemberSetting(database, "super_moderators", "posting.link_limit_exempt", true);

      const links =
        "[one](https://one.example) [two](https://two.example) [three](https://three.example)";
      const held = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Too many links",
          bodyMd: links,
        }),
      );
      const heldTopic = await readTopic(database.sql, held.topicId);
      expect(heldTopic?.visibility).toBe("unapproved");
      const [heldPost] = (await database.sql`
        SELECT visibility, hold_reason FROM core.posts WHERE id = ${held.postId}
      `) as Array<{ visibility: string; hold_reason: string | null }>;
      expect(heldPost).toEqual({ visibility: "unapproved", hold_reason: "link_limit" });

      const staff = expectOk(
        await startTopic(database.sql, {
          actorId: moderator,
          forumId: forum,
          title: "Staff links",
          bodyMd: links,
        }),
      );
      expect((await readTopic(database.sql, staff.topicId))?.visibility).toBe("visible");

      await setMemberSetting(database, "members", "posting.link_limit_action", "reject");
      expect(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Rejected links",
          bodyMd: links,
        }),
      ).toEqual({ ok: false, code: "too_many_links" });
    });
  }, 60_000);

  test("holds duplicate, rapid and blocklisted-link posts with the rule label", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "new-member");
      const forum = await forumId(database, "off-topic");
      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${member}`;

      await saveFilterSettings(database.sql, {
        duplicateEnabled: true,
        duplicateCount: 2,
        duplicateWindowMinutes: 10,
        rateEnabled: false,
        rateCount: 100,
        rateMinutes: 10,
      });
      const first = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Duplicate one",
          bodyMd: "Identical spam text.",
        }),
      );
      const second = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Duplicate two",
          bodyMd: "Identical spam text.",
        }),
      );
      const third = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Duplicate three",
          bodyMd: "Identical spam text.",
        }),
      );
      expect((await readTopic(database.sql, first.topicId))?.visibility).toBe("visible");
      for (const topic of [second, third]) {
        expect((await readTopic(database.sql, topic.topicId))?.visibility).toBe("unapproved");
        const [row] = (await database.sql`
          SELECT hold_reason FROM core.posts WHERE id = ${topic.postId}
        `) as Array<{ hold_reason: string | null }>;
        expect(row?.hold_reason).toBe("duplicate");
      }

      await saveFilterSettings(database.sql, {
        duplicateEnabled: false,
        duplicateCount: 2,
        duplicateWindowMinutes: 10,
        rateEnabled: true,
        rateCount: 2,
        rateMinutes: 10,
      });
      const rapidMember = await memberId(database, "account-member");
      await database.sql`UPDATE core.members SET post_count = 0 WHERE id = ${rapidMember}`;
      expectOk(
        await startTopic(database.sql, {
          actorId: rapidMember,
          forumId: forum,
          title: "Rapid one",
          bodyMd: "First rapid body.",
        }),
      );
      expectOk(
        await startTopic(database.sql, {
          actorId: rapidMember,
          forumId: forum,
          title: "Rapid two",
          bodyMd: "Second rapid body.",
        }),
      );
      const rapidThird = expectOk(
        await startTopic(database.sql, {
          actorId: rapidMember,
          forumId: forum,
          title: "Rapid three",
          bodyMd: "Third rapid body.",
        }),
      );
      const [rapidRow] = (await database.sql`
        SELECT hold_reason FROM core.posts WHERE id = ${rapidThird.postId}
      `) as Array<{ hold_reason: string | null }>;
      expect(rapidRow?.hold_reason).toBe("rate");

      await saveFilterSettings(database.sql, {
        duplicateEnabled: false,
        duplicateCount: 2,
        duplicateWindowMinutes: 10,
        rateEnabled: false,
        rateCount: 100,
        rateMinutes: 10,
      });
      expectOk(
        await saveFilterDomain(database.sql, {
          domain: "evil.example",
          enabled: true,
        }),
      );
      const blockedLink = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Bad domain",
          bodyMd: "[click](https://evil.example/path)",
        }),
      );
      const [domainRow] = (await database.sql`
        SELECT hold_reason FROM core.posts WHERE id = ${blockedLink.postId}
      `) as Array<{ hold_reason: string | null }>;
      expect(domainRow?.hold_reason).toBe("domain_blocklist");
    });
  }, 60_000);
});
