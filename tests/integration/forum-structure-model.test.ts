import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { loadForumTree } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

interface ForumInput {
  readonly title: string;
  readonly slug: string;
  readonly parentId?: string | null;
  readonly type?: "category" | "forum" | "redirect";
}

async function createForum(database: TestDatabase, input: ForumInput): Promise<string> {
  const [forum] = (await database.sql`
    INSERT INTO core.forums (parent_id, type, title, slug)
    VALUES (${input.parentId ?? null}, ${input.type ?? "forum"}, ${input.title}, ${input.slug})
    RETURNING id
  `) as Array<{ id: string }>;

  if (forum === undefined) {
    throw new Error(`Could not create forum ${input.title}`);
  }

  return forum.id;
}

async function pathOf(database: TestDatabase, forumId: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT path::text AS path FROM core.forums WHERE id = ${forumId}
  `) as Array<{ path: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${forumId}`);
  }

  return row.path;
}

async function expectRejection(query: () => PromiseLike<unknown>, pattern?: string): Promise<void> {
  try {
    await query();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (pattern !== undefined) {
      expect(message).toContain(pattern);
    }

    return;
  }

  throw new Error("Expected the statement to be rejected");
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  return member.id;
}

integrationDescribe("forum tree model", () => {
  test("moves a subtree and rewrites every descendant path", async () => {
    await withDb("forum_tree_move", async (database) => {
      const general = await createForum(database, {
        title: "General",
        slug: "general",
        type: "category",
      });
      const support = await createForum(database, {
        title: "Support",
        slug: "support",
        parentId: general,
      });
      const billing = await createForum(database, {
        title: "Billing",
        slug: "billing",
        parentId: support,
      });
      const invoices = await createForum(database, {
        title: "Invoices",
        slug: "invoices",
        parentId: billing,
      });
      const archive = await createForum(database, {
        title: "Archive",
        slug: "archive",
        type: "category",
      });

      expect(await pathOf(database, support)).toBe(`${general}.${support}`);
      expect(await pathOf(database, billing)).toBe(`${general}.${support}.${billing}`);
      expect(await pathOf(database, invoices)).toBe(`${general}.${support}.${billing}.${invoices}`);

      await database.sql`
        UPDATE core.forums SET parent_id = ${archive}, position = 3 WHERE id = ${support}
      `;

      expect(await pathOf(database, support)).toBe(`${archive}.${support}`);
      expect(await pathOf(database, billing)).toBe(`${archive}.${support}.${billing}`);
      expect(await pathOf(database, invoices)).toBe(`${archive}.${support}.${billing}.${invoices}`);

      const subtree = (await database.sql`
        SELECT id
        FROM core.forums
        WHERE path <@ (SELECT path FROM core.forums WHERE id = ${support})
        ORDER BY path
      `) as Array<{ id: string }>;

      expect(subtree.map((row) => row.id)).toEqual([support, billing, invoices]);

      const tree = await loadForumTree(database.sql);
      expect(tree.ancestors(invoices).map((node) => node.id)).toEqual([archive, support, billing]);
      expect(tree.descendants(archive).map((node) => node.id)).toEqual([
        support,
        billing,
        invoices,
      ]);
    });
  }, 30_000);

  test("rejects a move under the forum's own descendant", async () => {
    await withDb("forum_tree_cycle", async (database) => {
      const category = await createForum(database, {
        title: "Category",
        slug: "category",
        type: "category",
      });
      const level1 = await createForum(database, {
        title: "Level one",
        slug: "level-one",
        parentId: category,
      });
      const level2 = await createForum(database, {
        title: "Level two",
        slug: "level-two",
        parentId: level1,
      });
      const level3 = await createForum(database, {
        title: "Level three",
        slug: "level-three",
        parentId: level2,
      });
      const level4 = await createForum(database, {
        title: "Level four",
        slug: "level-four",
        parentId: level3,
      });
      const level5 = await createForum(database, {
        title: "Level five",
        slug: "level-five",
        parentId: level4,
      });

      const before = await pathOf(database, category);

      await expectRejection(
        () => database.sql`UPDATE core.forums SET parent_id = ${level5} WHERE id = ${category}`,
        "descendant",
      );
      await expectRejection(
        () => database.sql`UPDATE core.forums SET parent_id = ${level3} WHERE id = ${level1}`,
        "descendant",
      );
      await expectRejection(
        () => database.sql`UPDATE core.forums SET parent_id = ${level2} WHERE id = ${level2}`,
        "descendant",
      );

      expect(await pathOf(database, category)).toBe(before);
      expect(await pathOf(database, level5)).toBe(
        `${category}.${level1}.${level2}.${level3}.${level4}.${level5}`,
      );

      const tree = await loadForumTree(database.sql);
      expect(tree.lineage(level5).map((node) => node.id)).toEqual([
        category,
        level1,
        level2,
        level3,
        level4,
        level5,
      ]);
    });
  }, 30_000);

  test("records the old slug when a forum is renamed", async () => {
    await withDb("forum_tree_slug_history", async (database) => {
      const forum = await createForum(database, { title: "General", slug: "general" });

      await database.sql`UPDATE core.forums SET slug = 'general-discussion' WHERE id = ${forum}`;

      const history = (await database.sql`
        SELECT kind, resource_id, slug
        FROM core.slug_history
        WHERE kind = 'forum' AND resource_id = ${forum}
        ORDER BY id
      `) as Array<{ kind: string; resource_id: string; slug: string }>;

      expect(history).toEqual([{ kind: "forum", resource_id: forum, slug: "general" }]);
    });
  }, 30_000);
});

integrationDescribe("topic prefix model", () => {
  test("stores translatable labels, a group restriction and per-forum enablement", async () => {
    await withDb("forum_prefix_model", async (database) => {
      const forum = await createForum(database, { title: "Support", slug: "support" });
      const [prefix] = (await database.sql`
        INSERT INTO core.prefixes (key, colour, display_order)
        VALUES ('solved', '#1d9bf0', 1)
        RETURNING id
      `) as Array<{ id: string }>;

      if (prefix === undefined) {
        throw new Error("Could not create prefix");
      }

      await database.sql`
        INSERT INTO core.prefix_labels (prefix_id, locale, label)
        VALUES
          (${prefix.id}, 'en', 'Solved'),
          (${prefix.id}, 'es', 'Resuelto'),
          (${prefix.id}, 'fr', 'Résolu')
      `;
      await database.sql`
        INSERT INTO core.prefix_groups (prefix_id, group_id)
        SELECT ${prefix.id}, id FROM core.groups WHERE key = 'members'
      `;
      await database.sql`
        INSERT INTO core.forum_prefixes (forum_id, prefix_id, position)
        VALUES (${forum}, ${prefix.id}, 2)
      `;

      const labels = (await database.sql`
        SELECT locale, label FROM core.prefix_labels
        WHERE prefix_id = ${prefix.id}
        ORDER BY locale
      `) as Array<{ locale: string; label: string }>;
      expect(labels).toEqual([
        { locale: "en", label: "Solved" },
        { locale: "es", label: "Resuelto" },
        { locale: "fr", label: "Résolu" },
      ]);

      const [linked] = (await database.sql`
        SELECT f.title, p.key, p.colour, fp.position
        FROM core.forum_prefixes fp
        JOIN core.forums f ON f.id = fp.forum_id
        JOIN core.prefixes p ON p.id = fp.prefix_id
        WHERE f.id = ${forum}
      `) as Array<{ title: string; key: string; colour: string; position: number }>;
      expect(linked).toEqual({
        title: "Support",
        key: "solved",
        colour: "#1d9bf0",
        position: 2,
      });

      await database.sql`DELETE FROM core.prefixes WHERE id = ${prefix.id}`;

      const remaining = (await database.sql`
        SELECT 1 FROM core.forum_prefixes WHERE prefix_id = ${prefix.id}
      `) as unknown[];
      expect(remaining).toHaveLength(0);
    });
  }, 30_000);
});

integrationDescribe("announcement model", () => {
  test("stores targets, audiences and versioned dismissals", async () => {
    await withDb("forum_announcement_model", async (database) => {
      const forum = await createForum(database, { title: "Support", slug: "support" });
      const member = await createMember(database, "Dismissing Member");
      const [announcement] = (await database.sql`
        INSERT INTO core.announcements (title, body, scope, starts_at, ends_at)
        VALUES ('Maintenance', 'Tonight', 'forums', now() - interval '1 hour', now() + interval '1 day')
        RETURNING id, version
      `) as Array<{ id: string; version: number }>;

      if (announcement === undefined) {
        throw new Error("Could not create announcement");
      }

      await database.sql`
        INSERT INTO core.announcement_targets (announcement_id, forum_id, include_subforums)
        VALUES (${announcement.id}, ${forum}, true)
      `;
      await database.sql`
        INSERT INTO core.announcement_groups (announcement_id, group_id)
        SELECT ${announcement.id}, id FROM core.groups WHERE key = 'members'
      `;
      await database.sql`
        INSERT INTO core.announcement_dismissals (member_id, announcement_id, version)
        VALUES (${member}, ${announcement.id}, ${announcement.version})
      `;

      await database.sql`
        UPDATE core.announcements SET body = 'Tomorrow' WHERE id = ${announcement.id}
      `;

      const [updated] = (await database.sql`
        SELECT version FROM core.announcements WHERE id = ${announcement.id}
      `) as Array<{ version: number }>;
      expect(updated?.version).toBe(2);

      const dismissals = (await database.sql`
        SELECT version FROM core.announcement_dismissals WHERE announcement_id = ${announcement.id}
      `) as Array<{ version: number }>;
      expect(dismissals).toEqual([{ version: 1 }]);

      await expectRejection(
        () => database.sql`
          INSERT INTO core.announcements (title, starts_at, ends_at)
          VALUES ('Broken window', now(), now() - interval '1 minute')
        `,
        "announcements_window_check",
      );

      await database.sql`DELETE FROM core.announcements WHERE id = ${announcement.id}`;

      const targets = (await database.sql`
        SELECT 1 FROM core.announcement_targets WHERE announcement_id = ${announcement.id}
      `) as unknown[];
      const remainingDismissals = (await database.sql`
        SELECT 1 FROM core.announcement_dismissals WHERE announcement_id = ${announcement.id}
      `) as unknown[];
      expect(targets).toHaveLength(0);
      expect(remainingDismissals).toHaveLength(0);
    });
  }, 30_000);
});
