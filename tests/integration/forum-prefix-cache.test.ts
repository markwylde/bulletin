import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { deletePrefix, savePrefix } from "../../apps/staff-api/src/prefixes.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "prefix_cache" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`No seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function refFor(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id, slug FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string; slug: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return `/forum/${row.id}-${row.slug}`;
}

async function prefixId(database: TestDatabase, key: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.prefixes WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing prefix ${key}`);
  }

  return row.id;
}

async function adminId(database: TestDatabase): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS id FROM pii.identities WHERE sub = 'admin'
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Missing admin");
  }

  return row.id;
}

async function label(
  database: TestDatabase,
  id: string,
  locale: "en" | "es" | "fr",
): Promise<string> {
  const [row] = (await database.sql`
    SELECT label FROM core.prefix_labels WHERE prefix_id = ${id} AND locale = ${locale}
  `) as Array<{ label: string }>;

  return row?.label ?? "";
}

async function labels(
  database: TestDatabase,
  id: string,
): Promise<Record<"en" | "es" | "fr", string>> {
  return {
    en: await label(database, id, "en"),
    es: await label(database, id, "es"),
    fr: await label(database, id, "fr"),
  };
}

integrationDescribe("prefix mutations invalidate rendered forum pages", () => {
  test("edit, restriction change and deletion invalidate every affected warm page", async () => {
    await withSeededDb(async (database) => {
      const actor = await adminId(database);
      const member = await memberSession(database, "member-1");
      const question = await prefixId(database, "question");
      const solved = await prefixId(database, "solved");
      const bug = await prefixId(database, "bug");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const forum2 = await refFor(database, "help-questions");
        const help = forum2;
        const unrelated = await refFor(database, "off-topic");
        const render = async (ref: string) => {
          const result = await renderForumRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: member,
            ref,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

          if (result.kind !== "page") {
            throw new Error("Expected a page");
          }

          return result;
        };

        const forumWarm = await render(forum2);
        const helpWarm = await render(help);
        const unrelatedWarm = await render(unrelated);

        expect(forumWarm.cache).toBe("miss");
        expect(forumWarm.html).toContain(">Question<");
        expect(helpWarm.html).toContain(">Bug<");
        expect(unrelatedWarm.cache).toBe("miss");

        const edited = await savePrefix(database.sql, actor, {
          id: question,
          key: "question",
          colour: "#123456",
          labels: { en: "Inquiry", es: "Consulta", fr: "Demande" },
          groupIds: [],
        });

        expect(edited.ok).toBe(true);
        await versions.refresh();

        const forumAfterEdit = await render(forum2);

        expect(forumAfterEdit.cache).toBe("miss");
        expect(forumAfterEdit.html).toContain(">Inquiry<");
        expect(forumAfterEdit.html).toContain("--bl-prefix: #123456");
        // A forum not using the prefix keeps its warm fragment.
        expect((await render(unrelated)).cache).toBe("hit");

        const administrators = (await database.sql`
          SELECT id::text AS id FROM core.groups WHERE key = 'administrators'
        `) as Array<{ id: string }>;

        if (administrators[0] === undefined) {
          throw new Error("Missing administrators group");
        }

        const restricted = await savePrefix(database.sql, actor, {
          id: solved,
          key: "solved",
          colour: "#2f855a",
          labels: await labels(database, solved),
          groupIds: [administrators[0].id],
        });

        expect(restricted.ok).toBe(true);
        await versions.refresh();

        const forumAfterRestriction = await render(forum2);

        expect(forumAfterRestriction.cache).toBe("miss");
        expect(forumAfterRestriction.html).not.toContain(">Solved<");

        const removed = await deletePrefix(database.sql, actor, { id: bug });

        expect(removed.ok).toBe(true);
        await versions.refresh();

        const helpAfterDelete = await render(help);

        expect(helpAfterDelete.cache).toBe("miss");
        expect(helpAfterDelete.html).not.toContain(">Bug<");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
