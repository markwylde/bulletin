import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
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
  topicsSeedModule,
} from "@bulletin/db/seed";
import { canonicalUrl } from "@bulletin/domain/urls";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveBoardSettings } from "../../apps/staff-api/src/board-settings.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import { renderProfileRoute } from "../../apps/user-app/src/profiles/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "seo_metadata" }, async (database) => {
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
        topicsSeedModule,
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

async function createPagedTopic(
  database: TestDatabase,
  forumId: string,
  authorId: string,
): Promise<{ readonly id: string; readonly slug: string }> {
  const slug = "seo-paged-topic";
  const [topic] = (await database.sql`
    INSERT INTO core.topics (
      forum_id, title, slug, starter_id, lang, created_at, updated_at, last_post_at
    )
    VALUES (
      ${forumId}, 'A paged SEO topic', ${slug}, ${authorId}, 'english'::regconfig,
      now() - interval '1 hour', now(), now()
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not insert the paged topic");
  }

  for (let position = 1; position <= 3; position += 1) {
    const body = position === 1 ? "The first post describes the discussion." : `Reply ${position}.`;
    await database.sql`
      INSERT INTO core.posts (
        topic_id, author_id, body_md, body_html, body_text, render_version,
        sanitiser_version, position, visibility, lang, created_at
      )
      VALUES (
        ${topic.id}, ${authorId}, ${body}, ${`<p>${body}</p>`}, ${body}, 1, 1,
        ${position}, 'visible', 'english'::regconfig, now() + ${position} * interval '1 minute'
      )
    `;
  }

  return { id: topic.id, slug };
}

integrationDescribe("route metadata", () => {
  test("topic page 2 canonicalises to its clean page URL and carries discussion JSON-LD", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const admin = await memberSession(database, "admin");
      const topic = await createPagedTopic(database, announcements, admin.memberId);
      const saved = await saveBoardSettings(database.sql, admin.memberId, {
        boardName: "Bulletin",
        boardDescription: "",
        defaultLocale: "en",
        offline: false,
        offlineMessage: "",
        postsPerPage: 2,
      });
      expect(saved.ok).toBe(true);

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const result = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${topic.id}-${topic.slug}/page/2`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache: createRenderCache({ tags: versions }),
          tagVersions: versions,
        });

        expect(result.kind).toBe("page");

        if (result.kind !== "page") {
          throw new Error("Expected a page");
        }

        expect(result.status).toBe(200);
        expect(result.seo.canonicalPath).toBe(`/topic/${topic.id}-${topic.slug}/page/2`);
        expect(result.seo.robots).toBe("index");
        expect(result.seo.description).toContain("The first post describes the discussion.");
        expect(result.seo.type).toBe("article");
        expect(result.seo.jsonLd).toMatchObject({
          "@type": "DiscussionForumPosting",
          headline: "A paged SEO topic",
        });
        expect(result.seo.alternates[0]).toEqual({
          hreflang: "en",
          path: `/topic/${topic.id}-${topic.slug}/page/2?lang=en`,
        });
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("forums index for guests and mark pages guests cannot see as noindex", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const staffRoom = await forumId(database, "staff-room");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const publicResult = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${announcements}-announcements`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });
        const staffResult = await renderForumRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: await memberSession(database, "super-mod"),
          ref: `${staffRoom}-staff-room`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });

        expect(publicResult.kind).toBe("page");
        expect(staffResult.kind).toBe("page");

        if (publicResult.kind !== "page" || staffResult.kind !== "page") {
          throw new Error("Expected two pages");
        }

        expect(publicResult.status).toBe(200);
        expect(publicResult.seo.robots).toBe("index");
        expect(publicResult.seo.canonicalPath).toBe(`/forum/${announcements}-announcements`);
        expect(staffResult.status).toBe(200);
        expect(staffResult.seo.robots).toBe("noindex");
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("a word-filtered display name keeps the profile canonical on the resolvable URL", async () => {
    await withSeededDb(async (database) => {
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        VALUES ('Frobnicator Smith', 'frobnicator-smith-seo')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("Could not insert the profile member");
      }

      await database.sql`
        INSERT INTO core.filter_words (word, mode, replacement, match_mode)
        VALUES ('frobnicator', 'replace', 'Hidden', 'whole')
      `;

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const canonical = canonicalUrl("profile", member.id, "Frobnicator Smith");
        const render = (ref: string) =>
          renderProfileRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const result = await render(canonical.slice("/profile/".length));

        expect(result.kind).toBe("page");

        if (result.kind !== "page") {
          throw new Error("Expected the profile page");
        }

        // The page title is filtered, the canonical slug comes from the stored name.
        expect(result.title).toContain("Hidden");
        expect(result.seo.canonicalPath).toBe(canonical);
        expect(result.seo.canonicalPath).not.toContain("hidden");
        expect(result.seo.jsonLd).toMatchObject({ url: canonical });

        // The canonical is served directly; the filtered slug is the one that redirects.
        const filtered = await render(`${member.id}-hidden-smith`);
        expect(filtered).toMatchObject({ kind: "redirect", status: 301, location: canonical });
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("topic and profile metadata apply the current replace list before re-rendering", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const [member] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton, about_md, about_html)
        VALUES (
          'Quux Writer', 'quux-writer-seo', 'I write about quux.', '<p>I write about quux.</p>'
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (member === undefined) {
        throw new Error("Could not insert the member");
      }

      const [topic] = (await database.sql`
        INSERT INTO core.topics (
          forum_id, title, slug, starter_id, lang, created_at, updated_at, last_post_at
        )
        VALUES (
          ${announcements}, 'A quux topic', 'a-quux-topic', ${member.id}, 'english'::regconfig,
          now(), now(), now()
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position, visibility, lang
        )
        VALUES (
          ${topic?.id}, ${member.id}, 'Quux everywhere.', '<p>Quux everywhere.</p>',
          'Quux everywhere.', 1, 1, 1, 'visible', 'english'::regconfig
        )
      `;
      // Stored before the rule exists, and no re-render job runs in this test.
      await database.sql`
        INSERT INTO core.filter_words (word, mode, replacement, match_mode)
        VALUES ('quux', 'replace', 'thing', 'whole')
      `;

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const common = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };
        const topicResult = await renderTopicRoute({ ...common, ref: `${topic?.id}-a-quux-topic` });
        const profileResult = await renderProfileRoute({
          ...common,
          ref: canonicalUrl("profile", member.id, "Quux Writer").slice("/profile/".length),
        });

        if (topicResult.kind !== "page" || profileResult.kind !== "page") {
          throw new Error("Expected both pages");
        }

        expect(topicResult.seo.description).toBe("thing everywhere.");
        expect(topicResult.seo.title).not.toMatch(/quux/i);
        // URLs keep the stored slug (resolved by ID); every published text is filtered.
        expect(topicResult.seo.jsonLd).toMatchObject({
          headline: "A thing topic",
          author: { name: "thing Writer" },
        });
        expect(topicResult.tags).toContain("filters");
        expect(profileResult.seo.description).toBe("I write about thing.");
        expect(profileResult.seo.title).not.toMatch(/quux/i);
        expect(profileResult.seo.jsonLd).toMatchObject({
          name: "thing Writer",
          description: "I write about thing.",
        });
      } finally {
        await versions.close();
      }
    });
  }, 60_000);
});
