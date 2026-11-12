import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import {
  CapabilityView,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import { consumeSearchFlood, searchContent, searchMembers } from "@bulletin/domain/search";
import { reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "search_query" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
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

async function capabilityFor(
  database: TestDatabase,
  principal: ViewerPrincipal,
): Promise<CapabilityView> {
  const tree = await loadForumTree(database.sql);
  const snapshot = await loadPermissionSnapshot(database.sql, principal, { tree, sessionId: null });

  return new CapabilityView({ ...snapshot, view: "search" });
}

async function search(
  database: TestDatabase,
  principal: ViewerPrincipal,
  input: Parameters<typeof searchContent>[2],
) {
  return searchContent(
    database.sql,
    { capability: await capabilityFor(database, principal), locale: "en" },
    input,
  );
}

let sequence = 0;

interface InsertedContent {
  readonly topicId: string;
  readonly postId: string;
}

async function insertContent(
  database: TestDatabase,
  input: {
    readonly forumId: string;
    readonly authorId: string;
    readonly title: string;
    readonly body: string;
    readonly lang?: string;
    readonly visibility?: "visible" | "unapproved" | "soft_deleted";
    readonly topicVisibility?: "visible" | "unapproved" | "soft_deleted";
    readonly prefixId?: string | null;
    readonly createdAt?: Date;
  },
): Promise<InsertedContent> {
  sequence += 1;
  const createdAt = input.createdAt ?? new Date();
  const [topic] = (await database.sql`
    INSERT INTO core.topics (
      forum_id, title, slug, starter_id, prefix_id, visibility, lang,
      created_at, updated_at, last_post_at
    )
    VALUES (
      ${input.forumId}, ${input.title}, ${`search-test-${sequence}`}, ${input.authorId},
      ${input.prefixId ?? null}, ${input.topicVisibility ?? "visible"}, ${input.lang ?? "simple"}::regconfig,
      ${createdAt}, ${createdAt}, ${createdAt}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not insert the search topic");
  }

  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position, visibility, lang, created_at
    )
    VALUES (
      ${topic.id}, ${input.authorId}, ${input.body}, ${`<p>${input.body}</p>`}, ${input.body},
      1, 1, 1, ${input.visibility ?? "visible"}, ${input.lang ?? "simple"}::regconfig, ${createdAt}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (post === undefined) {
    throw new Error("Could not insert the search post");
  }

  return { topicId: topic.id, postId: post.id };
}

async function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): Promise<T> {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

integrationDescribe("search query", () => {
  test("matches stems, quoted phrases and exclusions in posts and topics", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const running = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Running club",
        body: "I run every morning before work.",
        lang: "english",
      });
      const supply = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Hardware notes",
        body: "The power supply is quiet and stays cool.",
        lang: "english",
      });
      const laptop = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Laptop notes",
        body: "My laptop power supply failed twice.",
        lang: "english",
      });
      const nonadjacent = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Nonadjacent phrase",
        body: "The power from the supply is stable.",
        lang: "english",
      });
      const reversed = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Reversed phrase",
        body: "The supply of power is stable.",
        lang: "english",
      });
      const orchids = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Orchid note",
        body: "Only orchidword grows here.",
        lang: "english",
      });
      const begonias = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Begonia note",
        body: "Only begoniaword grows here.",
        lang: "english",
      });
      const markup = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Snippet markup",
        body: "The literal <b> code shows markersnippet as text.",
        lang: "english",
      });

      const stems = await search(database, author, {
        query: "running",
        kind: "posts",
      });
      expect(stems.items.map((item) => item.kind === "post" && item.postId)).toContain(
        running.postId,
      );

      const topics = await search(database, author, { query: "run", kind: "topics" });
      expect(topics.items.map((item) => item.kind === "topic" && item.topicId)).toContain(
        running.topicId,
      );

      const phrase = await search(database, author, {
        query: '"power supply" -laptop',
        kind: "posts",
      });
      const postIds = phrase.items.map((item) => item.kind === "post" && item.postId);
      expect(postIds).toContain(supply.postId);
      expect(postIds).not.toContain(laptop.postId);
      expect(postIds).not.toContain(nonadjacent.postId);
      expect(postIds).not.toContain(reversed.postId);

      const either = await search(database, author, {
        query: "orchidword OR begoniaword",
        kind: "posts",
      });
      const eitherIds = either.items.map((item) => item.kind === "post" && item.postId);
      expect(eitherIds).toContain(orchids.postId);
      expect(eitherIds).toContain(begonias.postId);

      const snippetHit = await search(database, author, {
        query: "markersnippet",
        kind: "posts",
      });
      const snippet = snippetHit.items.find(
        (item) => item.kind === "post" && item.postId === markup.postId,
      );
      expect(snippet?.snippet).toContain("&lt;b&gt;");
      expect(snippet?.snippet).toContain("<mark>markersnippet</mark>");
      expect(snippet?.snippet).not.toContain("<b>");
    });
  });

  test("matches title typos with the trigram index", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const maintenance = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Scheduled maintenance window",
        body: "The board will be offline.",
        lang: "english",
      });

      const typo = await search(database, author, {
        query: "maintanance",
        kind: "topics",
      });

      expect(typo.items.map((item) => item.kind === "topic" && item.topicId)).toContain(
        maintenance.topicId,
      );
    });
  });

  test("never returns content from a forum the viewer cannot read", async () => {
    await withSeededDb(async (database) => {
      const staffRoom = await forumId(database, "staff-room");
      const admin = await memberId(database, "admin");
      const hidden = await insertContent(database, {
        forumId: staffRoom,
        authorId: admin,
        title: "Staff-only briefing",
        body: "The word staffonlyquokka appears only here.",
        lang: "english",
      });

      const guest = await search(database, GUEST_PRINCIPAL, {
        query: "staffonlyquokka",
        kind: "posts",
      });
      expect(guest.items).toHaveLength(0);

      const staff = await search(database, admin, { query: "staffonlyquokka", kind: "posts" });
      expect(staff.items.map((item) => item.kind === "post" && item.postId)).toContain(
        hidden.postId,
      );
    });
  });

  test("stops showing soft-deleted and held content unless the viewer has the power", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "member-2");
      const deleted = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Deleted later",
        body: "The word deletedquokka is indexed first.",
        lang: "english",
      });
      const held = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Held for approval",
        body: "The word heldquokka is waiting for approval.",
        lang: "english",
      });

      expect(
        (await search(database, author, { query: "deletedquokka", kind: "posts" })).items,
      ).toHaveLength(1);

      await database.sql`
        UPDATE core.posts SET visibility = 'soft_deleted' WHERE id = ${deleted.postId}
      `;
      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${held.postId}
      `;

      const memberDeleted = await search(database, author, {
        query: "deletedquokka",
        kind: "posts",
      });
      const memberHeld = await search(database, author, { query: "heldquokka", kind: "posts" });
      expect(memberDeleted.items).toHaveLength(0);
      expect(memberHeld.items).toHaveLength(0);

      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (
          ${announcements}, ${moderator},
          ${"{see_unapproved,see_deleted}"}::text[], true
        )
      `;

      const moderatorDeleted = await search(database, moderator, {
        query: "deletedquokka",
        kind: "posts",
      });
      const moderatorHeld = await search(database, moderator, {
        query: "heldquokka",
        kind: "posts",
      });
      expect(moderatorDeleted.items.map((item) => item.kind === "post" && item.postId)).toContain(
        deleted.postId,
      );
      expect(moderatorHeld.items.map((item) => item.kind === "post" && item.postId)).toContain(
        held.postId,
      );
    });
  });

  test("filters held and deleted topics for ordinary viewers and each moderator power", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const unapprovedMod = await memberId(database, "member-2");
      const deletedMod = await memberId(database, "new-member");
      const held = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Held topic quarantineword",
        body: "A reply inside the quarantinebody.",
        topicVisibility: "unapproved",
      });
      const deleted = await insertContent(database, {
        forumId: announcements,
        authorId: author,
        title: "Deleted topic embargoword",
        body: "A reply inside the embargobody.",
        topicVisibility: "soft_deleted",
      });

      const heldTopic = await search(database, author, {
        query: "quarantineword",
        kind: "topics",
      });
      const heldPost = await search(database, author, {
        query: "quarantinebody",
        kind: "posts",
      });
      const deletedTopic = await search(database, author, {
        query: "embargoword",
        kind: "topics",
      });
      const deletedPost = await search(database, author, {
        query: "embargobody",
        kind: "posts",
      });
      expect(heldTopic.items).toHaveLength(0);
      expect(heldPost.items).toHaveLength(0);
      expect(deletedTopic.items).toHaveLength(0);
      expect(deletedPost.items).toHaveLength(0);

      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (${announcements}, ${unapprovedMod}, ${"{see_unapproved}"}::text[], true)
      `;
      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (${announcements}, ${deletedMod}, ${"{see_deleted}"}::text[], true)
      `;

      const unapprovedTopics = await search(database, unapprovedMod, {
        query: "quarantineword",
        kind: "topics",
      });
      const unapprovedPosts = await search(database, unapprovedMod, {
        query: "quarantinebody",
        kind: "posts",
      });
      const unapprovedDeleted = await search(database, unapprovedMod, {
        query: "embargoword",
        kind: "topics",
      });
      expect(unapprovedTopics.items.map((item) => item.kind === "topic" && item.topicId)).toContain(
        held.topicId,
      );
      expect(unapprovedPosts.items.map((item) => item.kind === "post" && item.postId)).toContain(
        held.postId,
      );
      expect(unapprovedDeleted.items).toHaveLength(0);

      const deletedTopics = await search(database, deletedMod, {
        query: "embargoword",
        kind: "topics",
      });
      const deletedPosts = await search(database, deletedMod, {
        query: "embargobody",
        kind: "posts",
      });
      const deletedHeld = await search(database, deletedMod, {
        query: "quarantineword",
        kind: "topics",
      });
      expect(deletedTopics.items.map((item) => item.kind === "topic" && item.topicId)).toContain(
        deleted.topicId,
      );
      expect(deletedPosts.items.map((item) => item.kind === "post" && item.postId)).toContain(
        deleted.postId,
      );
      expect(deletedHeld.items).toHaveLength(0);
    });
  });

  test("does not match quoted text through the quoting post", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const source = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: announcements,
          title: "Quote source",
          bodyMd: "The source contains uniquequotealpha and nothing else.",
        }),
      );
      const quote = await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: source.topicId,
          bodyMd: `:::quote{source="post:${source.postId}"}\nquoted text\n:::\n\nquotebeta is my reply.`,
        }),
      );

      const quoted = await search(database, author, {
        query: "uniquequotealpha",
        kind: "posts",
      });
      const quotedPostIds = quoted.items.map((item) => item.kind === "post" && item.postId);
      expect(quotedPostIds).toContain(source.postId);
      expect(quotedPostIds).not.toContain(quote.postId);

      const replyHit = await search(database, author, { query: "quotebeta", kind: "posts" });
      expect(replyHit.items.map((item) => item.kind === "post" && item.postId)).toContain(
        quote.postId,
      );
    });
  });

  test("filters by forum subtree, author, prefix, date and kind, and sorts", async () => {
    await withSeededDb(async (database) => {
      const support = await forumId(database, "support");
      const help = await forumId(database, "help-questions");
      const bugs = await forumId(database, "bug-reports");
      const offTopic = await forumId(database, "off-topic");
      const memberOne = await memberId(database, "member-1");
      const memberTwo = await memberId(database, "member-2");
      const [prefix] = (await database.sql`
        SELECT id::text AS id FROM core.prefixes ORDER BY id LIMIT 1
      `) as Array<{ id: string }>;
      const old = new Date("2020-01-01T12:00:00.000Z");
      const recent = new Date("2020-02-01T12:00:00.000Z");

      const inHelp = await insertContent(database, {
        forumId: help,
        authorId: memberOne,
        title: "Filter help",
        body: "filterword appears in help.",
        createdAt: old,
      });
      const inBugs = await insertContent(database, {
        forumId: bugs,
        authorId: memberTwo,
        title: "Filter bug",
        body: "filterword appears in bugs.",
        createdAt: old,
      });
      const inOffTopic = await insertContent(database, {
        forumId: offTopic,
        authorId: memberOne,
        title: "Filter café",
        body: "filterword appears off topic.",
        createdAt: recent,
      });
      const prefixed = await insertContent(database, {
        forumId: offTopic,
        authorId: memberOne,
        title: "Prefixed filter",
        body: "prefixword appears here.",
        ...(prefix === undefined ? {} : { prefixId: prefix.id }),
      });

      const subtree = await search(database, memberOne, {
        query: "filterword",
        kind: "posts",
        forumIds: [support],
      });
      const subtreeIds = subtree.items.map((item) => item.kind === "post" && item.postId);
      expect(subtreeIds).toContain(inHelp.postId);
      expect(subtreeIds).toContain(inBugs.postId);
      expect(subtreeIds).not.toContain(inOffTopic.postId);

      const byAuthor = await search(database, memberOne, {
        query: "filterword",
        kind: "posts",
        authorId: memberOne,
      });
      const authorIds = byAuthor.items.map((item) => item.kind === "post" && item.postId);
      expect(authorIds).toContain(inHelp.postId);
      expect(authorIds).not.toContain(inBugs.postId);

      const byDate = await search(database, memberOne, {
        query: "filterword",
        kind: "posts",
        createdFrom: new Date("2020-01-15T00:00:00.000Z"),
      });
      expect(byDate.items.map((item) => item.kind === "post" && item.postId)).toEqual([
        inOffTopic.postId,
      ]);

      if (prefix !== undefined) {
        const byPrefix = await search(database, memberOne, {
          query: "prefixword",
          kind: "posts",
          prefixIds: [prefix.id],
        });
        expect(byPrefix.items.map((item) => item.kind === "post" && item.postId)).toEqual([
          prefixed.postId,
        ]);
      }

      const titleOnly = await insertContent(database, {
        forumId: help,
        authorId: memberOne,
        title: "Kind-specific marker",
        body: "The body has no matching text.",
        createdAt: new Date("2020-03-01T12:00:00.000Z"),
      });
      const asTopics = await search(database, memberOne, {
        query: "kind-specific",
        kind: "topics",
      });
      expect(asTopics.items.map((item) => item.kind === "topic" && item.topicId)).toContain(
        titleOnly.topicId,
      );
      const asPosts = await search(database, memberOne, {
        query: "kind-specific",
        kind: "posts",
      });
      expect(asPosts.items).toHaveLength(0);

      const oldRepeated = await insertContent(database, {
        forumId: help,
        authorId: memberTwo,
        title: "Relevance wins",
        body: `rankword ${"rankword ".repeat(30)}`,
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
      });
      const newOnce = await insertContent(database, {
        forumId: help,
        authorId: memberTwo,
        title: "Date wins",
        body: "rankword appears once.",
        createdAt: new Date("2020-01-03T00:00:00.000Z"),
      });

      const byRelevance = await search(database, memberOne, {
        query: "rankword",
        kind: "posts",
        sort: "relevance",
      });
      const byRecency = await search(database, memberOne, {
        query: "rankword",
        kind: "posts",
        sort: "date",
      });
      expect(byRelevance.items[0]?.kind === "post" && byRelevance.items[0].postId).toBe(
        oldRepeated.postId,
      );
      expect(byRecency.items[0]?.kind === "post" && byRecency.items[0].postId).toBe(newOnce.postId);
    });
  });

  test("caps the result set at 1000 hits", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");

      await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id, created_at, updated_at)
        SELECT
          ${announcements}, 'Cap topic ' || value, 'cap-' || value, ${author},
          now() - (value || ' seconds')::interval, now()
        FROM generate_series(1, 1005) AS series(value)
      `;
      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position, created_at
        )
        SELECT
          topic.id, ${author}, 'capword', '<p>capword</p>', 'capword', 1, 1, 1,
          topic.created_at
        FROM core.topics AS topic
        WHERE topic.slug ~ '^cap-[0-9]+$'
      `;

      const page = await search(database, author, {
        query: "capword",
        kind: "posts",
        perPage: 20,
      });

      expect(page.total).toBe(1000);
      expect(page.pageCount).toBe(50);
      expect(page.items).toHaveLength(20);
      expect(page.capped).toBe(true);
    });
  });

  test("member search ranks a typo near the top and respects the list opt-out", async () => {
    await withSeededDb(async (database) => {
      const memberOne = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");
      const [adminGroup] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'administrators'
      `) as Array<{ id: string }>;

      if (adminGroup === undefined) {
        throw new Error("Missing administrators group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${adminGroup.id}, 'members.view_hidden', 'true'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`
        INSERT INTO core.members (display_name, locale)
        VALUES ('John', 'en'), ('Johnny', 'en'), ('Jhon', 'en')
      `;
      await database.sql`UPDATE core.members SET hide_from_member_list = true WHERE display_name = 'Jhon'`;

      const visible = await searchMembers(database.sql, memberOne, { query: "jhon" });
      expect(visible[0]?.displayName).toBe("John");
      expect(visible.map((member) => member.displayName)).not.toContain("Jhon");

      const withHidden = await searchMembers(database.sql, admin, { query: "jhon" });
      expect(withHidden.map((member) => member.displayName)).toContain("Jhon");
    });
  });

  test("counts concurrent searches atomically", async () => {
    await withSeededDb(async (database) => {
      const [guestGroup] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'guests'
      `) as Array<{ id: string }>;

      if (guestGroup === undefined) {
        throw new Error("Missing guest group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${guestGroup.id}, 'members.search_flood_seconds', '10'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const now = new Date("2026-01-01T00:00:00.000Z");
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () => consumeSearchFlood(database.sql, GUEST_PRINCIPAL, { now })),
      );

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(5);
    });
  });

  test("refuses searches inside the group's search interval", async () => {
    await withSeededDb(async (database) => {
      const [guestGroup] = (await database.sql`
        SELECT id FROM core.groups WHERE key = 'guests'
      `) as Array<{ id: string }>;

      if (guestGroup === undefined) {
        throw new Error("Missing guest group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${guestGroup.id}, 'members.search_flood_seconds', '10'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const start = new Date("2026-01-01T00:00:00.000Z");
      const first = await consumeSearchFlood(database.sql, GUEST_PRINCIPAL, { now: start });
      const tooSoon = await consumeSearchFlood(database.sql, GUEST_PRINCIPAL, {
        now: new Date(start.getTime() + 3_000),
      });
      const later = await consumeSearchFlood(database.sql, GUEST_PRINCIPAL, {
        now: new Date(start.getTime() + 10_000),
      });

      expect(first).toEqual({ ok: true, retryAfterSeconds: 0 });
      expect(tooSoon).toEqual({ ok: false, retryAfterSeconds: 7 });
      expect(later).toEqual({ ok: true, retryAfterSeconds: 0 });
    });
  });
});
