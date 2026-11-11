import { describe, expect, test } from "bun:test";
import { bumpCacheTags, createRenderCache, createTagVersions } from "@bulletin/cache";
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
import { saveMemberProfile } from "@bulletin/domain/profiles";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { createTestDatabase, type TestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import {
  type ProfileRouteInput,
  renderProfileRoute,
} from "../../apps/user-app/src/profiles/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const PUBLIC_VALUE = "I build small things on the web.";
const STAFF_VALUE = "Staff-only case note 4471";

interface Harness {
  readonly database: TestDatabase;
  readonly cache: ReturnType<typeof createRenderCache>;
  readonly versions: Awaited<ReturnType<typeof createTagVersions>>;
  readonly memberId: string;
  readonly publicForumId: string;
  readonly staffForumId: string;
}

async function seed(): Promise<Harness> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const database = await createTestDatabase({ adminUrl, prefix: "profile_page" });

  await runSeeds({
    sql: database.sql,
    registry: new SeedRegistry([
      baseSeedModule,
      permissionFixtureSeedModule,
      forumExtrasSeedModule,
      groupsSeedModule,
      membersSeedModule,
      moderatorAssignmentsSeedModule,
      topicsSeedModule,
      flagsSeedModule,
      themesSeedModule,
    ]),
  });

  const versions = await createTagVersions({
    sql: database.sql,
    heartbeatMs: 100,
    heartbeatTimeoutMs: 1_000,
  });
  const cache = createRenderCache({ tags: versions });

  return {
    database,
    cache,
    versions,
    ...(await ids(database)),
  };
}

async function ids(database: TestDatabase): Promise<{
  memberId: string;
  publicForumId: string;
  staffForumId: string;
}> {
  const [member] = (await database.sql`
    SELECT i.member_id::text AS member_id
    FROM pii.identities i
    WHERE i.sub = 'member-1'
  `) as Array<{ member_id: string }>;
  const [publicForum] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = 'off-topic'
  `) as Array<{ id: string }>;
  const [staffForum] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = 'staff-room'
  `) as Array<{ id: string }>;

  if (member === undefined || publicForum === undefined || staffForum === undefined) {
    throw new Error("The seed is missing the profile fixtures");
  }

  return {
    memberId: member.member_id,
    publicForumId: publicForum.id,
    staffForumId: staffForum.id,
  };
}

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return row.id;
}

async function createField(
  database: TestDatabase,
  input: {
    readonly type: string;
    readonly label: string;
    readonly required?: boolean;
    readonly options?: readonly string[];
    readonly visibleTo: readonly string[];
    readonly editableBy?: readonly string[];
  },
): Promise<string> {
  const labels = { en: input.label, es: input.label, fr: input.label };
  const options = (input.options ?? []).map((value) => ({
    value,
    labels: { en: value, es: value, fr: value },
  }));
  const [field] = (await database.sql`
    INSERT INTO core.profile_fields (type, required, labels, options, position)
    VALUES (${input.type}, ${input.required === true}, ${labels}::jsonb, ${options}::jsonb, 0)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (field === undefined) {
    throw new Error("Could not create the field");
  }

  for (const key of input.visibleTo) {
    await database.sql`
      INSERT INTO core.profile_field_groups (field_id, group_id, can_view, can_edit)
      VALUES (
        ${field.id},
        ${await groupId(database, key)},
        true,
        ${(input.editableBy ?? []).includes(key)}
      )
    `;
  }

  return field.id;
}

async function setValue(
  database: TestDatabase,
  memberId: string,
  fieldId: string,
  value: string,
): Promise<void> {
  await database.sql`
    INSERT INTO core.member_field_values (member_id, field_id, value)
    VALUES (${memberId}, ${fieldId}, ${value}::jsonb)
  `;
}

async function createPost(
  database: TestDatabase,
  input: {
    readonly memberId: string;
    readonly forumId: string;
    readonly title: string;
  },
): Promise<void> {
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${input.forumId}, ${input.title}, ${slug}, ${input.memberId})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not create the topic");
  }

  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
    )
    VALUES (
      ${topic.id}, ${input.memberId}, 'Profile fixture', '<p>Profile fixture</p>',
      'Profile fixture', 1, 1, 1
    )
    RETURNING id::text AS id, created_at
  `) as Array<{ id: string; created_at: Date }>;

  if (post === undefined) {
    throw new Error("Could not create the post");
  }

  await database.sql`
    UPDATE core.topics
    SET first_post_id = ${post.id}, last_post_id = ${post.id}, last_post_at = ${post.created_at}
    WHERE id = ${topic.id}
  `;
  await database.sql`
    UPDATE core.members SET post_count = post_count + 1 WHERE id = ${input.memberId}
  `;
}

async function session(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

function render(
  harness: Harness,
  input: { readonly session: UserAppSessionContext | null },
): Promise<Awaited<ReturnType<typeof renderProfileRoute>>> {
  return renderProfileRoute({
    sql: harness.database.sql,
    locale: "en",
    translate,
    session: input.session,
    ref: `${harness.memberId}-regular-member-one`,
    pluginsGeneration: 1,
    colourScheme: "system",
    cache: harness.cache,
    tagVersions: harness.versions,
  } satisfies ProfileRouteInput);
}

function htmlOf(result: Awaited<ReturnType<typeof renderProfileRoute>>): string {
  if (result.kind !== "page") {
    throw new Error("Expected a rendered page");
  }

  return result.html;
}

async function close(harness: Harness): Promise<void> {
  await harness.versions.close();
  await harness.database.drop();
}

integrationDescribe("profile page (member-profiles)", () => {
  test("a guest never receives a staff-only field", async () => {
    const harness = await seed();

    try {
      const publicField = await createField(harness.database, {
        type: "short_text",
        label: "Website",
        visibleTo: [],
      });
      const staffField = await createField(harness.database, {
        type: "short_text",
        label: "Moderator note",
        visibleTo: ["moderators", "administrators"],
      });

      await setValue(harness.database, harness.memberId, publicField, PUBLIC_VALUE);
      await setValue(harness.database, harness.memberId, staffField, STAFF_VALUE);

      const guest = await render(harness, { session: null });
      const member = await render(harness, {
        session: await session(harness.database, "member-2"),
      });

      expect(htmlOf(guest)).toContain(PUBLIC_VALUE);
      expect(htmlOf(guest)).not.toContain(STAFF_VALUE);
      expect(htmlOf(guest)).not.toContain("Moderator note");
      expect(htmlOf(member)).not.toContain(STAFF_VALUE);
    } finally {
      await close(harness);
    }
  }, 30_000);

  test("field visibility produces a variant per class with no leaked field", async () => {
    const harness = await seed();

    try {
      const publicField = await createField(harness.database, {
        type: "short_text",
        label: "Website",
        visibleTo: [],
      });
      const staffField = await createField(harness.database, {
        type: "short_text",
        label: "Moderator note",
        visibleTo: ["moderators", "administrators"],
      });

      await setValue(harness.database, harness.memberId, publicField, PUBLIC_VALUE);
      await setValue(harness.database, harness.memberId, staffField, STAFF_VALUE);
      // The staff-room post makes the admin's recent list differ as well.
      await createPost(harness.database, {
        memberId: harness.memberId,
        forumId: harness.staffForumId,
        title: "Staff room profile fixture",
      });

      const member = await session(harness.database, "member-2");
      const moderator = await session(harness.database, "member-mod");
      const admin = await session(harness.database, "admin");
      const cases: readonly VariantCase[] = [
        {
          name: "member",
          render: async () => {
            const result = await render(harness, { session: member });

            return {
              variant: result.variant ?? "",
              html: htmlOf(result),
              ...(result.cache === null ? {} : { cache: result.cache }),
            };
          },
        },
        {
          name: "moderator",
          render: async () => {
            const result = await render(harness, { session: moderator });

            return {
              variant: result.variant ?? "",
              html: htmlOf(result),
              ...(result.cache === null ? {} : { cache: result.cache }),
            };
          },
        },
        {
          name: "admin",
          render: async () => {
            const result = await render(harness, { session: admin });

            return {
              variant: result.variant ?? "",
              html: htmlOf(result),
              ...(result.cache === null ? {} : { cache: result.cache }),
            };
          },
        },
      ];

      const report = await assertCacheVariants({
        route: "/profile/[ref]",
        cases,
        cache: harness.cache,
        leaks: [
          {
            description: "staff-only field value",
            markers: [STAFF_VALUE, "Moderator note"],
            absentFrom: ["member"],
          },
          {
            description: "staff-room recent post",
            markers: ["Staff room profile fixture"],
            absentFrom: ["member", "moderator"],
          },
        ],
      });

      expect(new Set(report.variants.values()).size).toBe(3);
    } finally {
      await close(harness);
    }
  }, 30_000);

  test("recent posts are permission-filtered and the variant follows forum read bits", async () => {
    const harness = await seed();

    try {
      await createPost(harness.database, {
        memberId: harness.memberId,
        forumId: harness.publicForumId,
        title: "Public profile fixture",
      });
      await createPost(harness.database, {
        memberId: harness.memberId,
        forumId: harness.staffForumId,
        title: "Hidden profile fixture",
      });

      const guest = await render(harness, { session: null });
      const admin = await render(harness, { session: await session(harness.database, "admin") });

      expect(htmlOf(guest)).toContain("Public profile fixture");
      expect(htmlOf(guest)).not.toContain("Hidden profile fixture");
      expect(htmlOf(admin)).toContain("Hidden profile fixture");
      expect(admin.variant).not.toBe(guest.variant);
    } finally {
      await close(harness);
    }
  }, 30_000);

  test("a hidden member's last activity is visible only with members.view_hidden", async () => {
    const harness = await seed();

    try {
      await harness.database.sql`
        UPDATE core.members
        SET hide_online = true, last_active_at = now() - interval '5 minutes'
        WHERE id = ${harness.memberId}
      `;

      const guest = await render(harness, { session: null });
      const admin = await render(harness, { session: await session(harness.database, "admin") });

      expect(htmlOf(guest)).not.toContain("data-profile-last-active");
      expect(htmlOf(admin)).toContain("data-profile-last-active");
      expect(admin.variant).not.toBe(guest.variant);
    } finally {
      await close(harness);
    }
  }, 30_000);

  test("renders awarded badges on the profile", async () => {
    const harness = await seed();

    try {
      const [badge] = (await harness.database.sql`
        INSERT INTO core.badges (key, labels, description_labels, position)
        VALUES (
          'helpful',
          ${{ en: "Helpful", es: "Servicial", fr: "Serviable" }}::jsonb,
          ${{ en: "Always ready to help.", es: "Siempre listo para ayudar.", fr: "Toujours prêt à aider." }}::jsonb,
          1
        )
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (badge === undefined) {
        throw new Error("Could not create the badge");
      }

      await harness.database.sql`
        INSERT INTO core.member_badges (member_id, badge_id)
        VALUES (${harness.memberId}, ${badge.id})
      `;

      const english = htmlOf(await render(harness, { session: null }));
      expect(english).toContain("Helpful");
      expect(english).toContain("Always ready to help.");
    } finally {
      await close(harness);
    }
  }, 30_000);

  test("a profile save invalidates the member tag and rebuilds the page", async () => {
    const harness = await seed();

    try {
      const member = await session(harness.database, "member-1");
      const first = await render(harness, { session: member });

      expect(htmlOf(first)).not.toContain("A freshly written about section");

      await saveMemberProfile(harness.database.sql, {
        memberId: harness.memberId,
        aboutMd: "A freshly written **about** section",
        hideOnline: false,
        hideFromMemberList: false,
        values: {},
        fields: [],
      });

      const started = Date.now();

      while (harness.versions.version(`member:${harness.memberId}`) === "0") {
        if (Date.now() - started > 3_000) {
          throw new Error("Timed out waiting for the member tag");
        }

        await Bun.sleep(20);
      }

      const second = await render(harness, { session: member });

      expect(second.cache).toBe("miss");
      expect(htmlOf(second)).toContain("A freshly written <strong>about</strong> section");

      // A board-wide field definition change rebuilds every profile too.
      await bumpCacheTags(harness.database.sql, ["profile_fields"]);
      const startedFields = Date.now();

      while (harness.versions.version("profile_fields") === "0") {
        if (Date.now() - startedFields > 3_000) {
          throw new Error("Timed out waiting for the profile_fields tag");
        }

        await Bun.sleep(20);
      }

      expect((await render(harness, { session: member })).cache).toBe("miss");
    } finally {
      await close(harness);
    }
  }, 30_000);

  test("older readable posts remain visible behind a run of private posts", async () => {
    const harness = await seed();

    try {
      const staffForum = (await harness.database.sql`
        SELECT id::text AS id FROM core.forums WHERE slug = 'staff-room'
      `) as Array<{ id: string }>;
      const forum = staffForum[0]?.id;

      if (forum === undefined) {
        throw new Error("Missing staff forum");
      }

      await createPost(harness.database, {
        memberId: harness.memberId,
        forumId: harness.publicForumId,
        title: "Older readable profile post",
      });

      for (let index = 0; index < 20; index += 1) {
        await createPost(harness.database, {
          memberId: harness.memberId,
          forumId: forum,
          title: `Recent private profile post ${index}`,
        });
      }

      const result = await render(harness, { session: null });
      expect(htmlOf(result)).toContain("Older readable profile post");
      expect(htmlOf(result)).not.toContain("Recent private profile post");
    } finally {
      await close(harness);
    }
  }, 30_000);
});
