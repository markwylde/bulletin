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
import { readProfile } from "@bulletin/domain/profiles";
import { startTopic } from "@bulletin/domain/topics";
import { slugify } from "@bulletin/domain/urls";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { profileSaveResponse } from "../../apps/user-api/src/profile.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "signatures" }, async (database) => {
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

async function setSignatureLimits(
  database: TestDatabase,
  input: {
    readonly chars: number;
    readonly lines: number;
    readonly images: number;
    readonly links: number;
  },
): Promise<void> {
  const [group] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = 'members'
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error("Missing members group");
  }

  for (const [key, value] of [
    ["members.signature_max_chars", input.chars],
    ["members.signature_max_lines", input.lines],
    ["members.signature_max_images", input.images],
    ["members.signature_max_links", input.links],
  ] as const) {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      VALUES (${group.id}, ${key}, to_jsonb(${value}::int))
      ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
  }
}

function request(body: unknown): Request {
  return new Request("http://bulletin.localhost/api/me/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function session(id: string) {
  return { memberId: id, id: "0" } as never;
}

integrationDescribe("signatures", () => {
  test("rejects a signature above the group's link limit and names the limit", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      await setSignatureLimits(database, { chars: 200, lines: 3, images: 1, links: 2 });

      const response = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "",
          hideOnline: false,
          hideFromMemberList: false,
          hideSignatures: false,
          signatureMd:
            "[one](https://example.com/1) [two](https://example.com/2) [three](https://example.com/3)",
          values: {},
        }),
      );

      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toEqual({
        code: "signature_too_many_links",
        limit: 2,
      });
      expect((await readProfile(database.sql, member))?.signatureMd).toBe("");
    });
  }, 30_000);

  test("saves a rendered signature and shows it under the member's posts", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");
      await setSignatureLimits(database, { chars: 200, lines: 3, images: 1, links: 2 });

      const saved = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "",
          hideOnline: false,
          hideFromMemberList: false,
          hideSignatures: false,
          signatureMd: "Hello *world* from the signature",
          values: {},
        }),
      );
      expect(saved.status).toBe(200);
      expect((await readProfile(database.sql, member))?.signatureHtml).toContain("<em>world</em>");

      const started = await startTopic(database.sql, {
        actorId: member,
        forumId: forum,
        title: "Signature rendering fixture",
        bodyMd: "A post with a signature.",
      });

      expect(started.ok).toBe(true);

      if (!started.ok) {
        throw new Error("Could not start the fixture topic");
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: `${started.result.topicId}-${slugify("Signature rendering fixture")}`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const first = await render();
        expect(first.kind).toBe("page");
        expect(first.html).toContain(`data-signature="${member}"`);
        expect(first.html).toContain("<em>world</em>");

        // A signature edit invalidates only its fragment; the topic page cache stays warm.
        const edited = await profileSaveResponse(
          database.sql,
          session(member),
          request({
            about: "",
            hideOnline: false,
            hideFromMemberList: false,
            hideSignatures: false,
            signatureMd: "The *new* signature",
            values: {},
          }),
        );
        expect(edited.status).toBe(200);

        const tag = `member:${member}`;
        const deadline = Date.now() + 3_000;

        while (versions.version(tag) === "0") {
          if (Date.now() > deadline) {
            throw new Error("Timed out waiting for the member tag");
          }

          await Bun.sleep(20);
        }

        const second = await render();
        expect(second.kind).toBe("page");
        expect(second.cache).toBe("hit");
        expect(second.html).toContain("<em>new</em>");
        expect(second.html).not.toContain("<em>world</em>");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("stores the hide-all-signatures preference without changing shared HTML", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      await setSignatureLimits(database, { chars: 200, lines: 3, images: 1, links: 2 });

      const response = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "",
          hideOnline: false,
          hideFromMemberList: false,
          hideSignatures: true,
          signatureMd: "Visible in shared HTML",
          values: {},
        }),
      );

      expect(response.status).toBe(200);
      expect((await readProfile(database.sql, member))?.hideSignatures).toBe(true);
      // The preference is personal: the stored signature remains available for the overlay.
      expect((await readProfile(database.sql, member))?.signatureHtml).toContain(
        "Visible in shared HTML",
      );
    });
  }, 30_000);
});
