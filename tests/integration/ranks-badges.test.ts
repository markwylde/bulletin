import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions, readTagVersion } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
  topicsSeedModule,
} from "@bulletin/db/seed";
import {
  awardBadge,
  deleteBadge,
  evaluateAllBadgeRules,
  evaluateBadgeRulesForEvent,
  evaluateBadgeRulesForMember,
  readMemberBadges,
  saveBadge,
} from "@bulletin/domain/badges";
import { loadEvent } from "@bulletin/domain/events";
import { readProfile, saveMemberProfile } from "@bulletin/domain/profiles";
import { saveRank } from "@bulletin/domain/ranks";
import { loadMemberCards } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { safeHtml } from "@bulletin/templates";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderProfileRoute } from "../../apps/user-app/src/profiles/route.ts";
import { renderMemberCards } from "../../apps/user-app/src/topics/fragments.ts";
import { renderPostBlock } from "../../apps/user-app/src/topics/post-block.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "ranks_badges" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        forumExtrasSeedModule,
        groupsSeedModule,
        membersSeedModule,
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

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return row.id;
}

async function setGroupSetting(
  database: TestDatabase,
  group: string,
  key: string,
  value: boolean | number,
): Promise<void> {
  const groupRow = await groupId(database, group);

  if (typeof value === "boolean") {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      VALUES (${groupRow}, ${key}, to_jsonb(${value}))
      ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
    `;
  } else {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      VALUES (${groupRow}, ${key}, to_jsonb(${value}::int))
      ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}

function route(id: string): StaffRoute {
  const found = STAFF_ROUTES.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`Missing staff route ${id}`);
  }

  return found;
}

function call(
  database: TestDatabase,
  memberIdValue: string,
  target: StaffRoute,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://staff.localhost${target.path}`);

  return authorizeStaffRoute(target, {
    request: new Request(url, {
      method: target.method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    url,
    session: { memberId: memberIdValue, lastAuthAt: new Date() } as never,
    sql: database.sql,
    checks: [],
  });
}

const LABELS = { en: "Label", es: "Etiqueta", fr: "Libellé" };

integrationDescribe("ranks and badges", () => {
  test("rank titles, pips, custom titles and featured badges reach the author card", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");

      await saveRank(database.sql, {
        id: null,
        minPosts: 0,
        titleLabels: { en: "Newcomer", es: "Novato", fr: "Débutant" },
        pips: 1,
        imageKey: null,
      });
      await saveRank(database.sql, {
        id: null,
        minPosts: 100,
        titleLabels: { en: "Veteran", es: "Veterano", fr: "Vétéran" },
        pips: 3,
        imageKey: null,
      });
      expect(await readTagVersion(database.sql, "ranks")).toBe("2");

      await setGroupSetting(database, "members", "members.can_custom_title", true);
      await setGroupSetting(database, "members", "members.custom_title_max_chars", 20);

      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "",
          hideOnline: false,
          hideFromMemberList: false,
          customTitle: "Night Owl",
          values: {},
          fields: [],
        }),
      ).toEqual({ ok: true });
      expect(await readTagVersion(database.sql, `member:${member}`)).toBe("1");

      const badgeId = await saveBadge(database.sql, {
        id: null,
        key: "helpful",
        labels: { en: "Helpful", es: "Servicial", fr: "Serviable" },
        descriptionLabels: { en: "Helps", es: "Ayuda", fr: "Aide" },
        imageKey: null,
        position: 0,
        rule: null,
      });
      expect(
        await awardBadge(database.sql, {
          memberId: member,
          badgeId,
          actorId: null,
          reason: null,
        }),
      ).toBe(true);
      expect(Number(await readTagVersion(database.sql, "badges"))).toBeGreaterThanOrEqual(1);
      expect(Number(await readTagVersion(database.sql, `member:${member}`))).toBeGreaterThanOrEqual(
        2,
      );
      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "",
          hideOnline: false,
          hideFromMemberList: false,
          featuredBadges: [badgeId],
          values: {},
          fields: [],
        }),
      ).toEqual({ ok: true });

      const cards = await loadMemberCards(database.sql, [member], "en");
      const card = cards.get(member);
      expect(card?.rankTitle).toBe("Veteran");
      expect(card?.rankPips).toBe(3);
      expect(card?.customTitle).toBe("Night Owl");
      expect(card?.featuredBadges).toEqual([{ label: "Helpful", imageKey: null }]);
      const profile = await readProfile(database.sql, member);
      expect(profile?.rankTitleLabels?.en).toBe("Veteran");
      expect(profile?.customTitle).toBe("Night Owl");
    });
  }, 30_000);

  test("custom titles enforce permission, length and the bad-word hook", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      await setGroupSetting(database, "members", "members.can_custom_title", false);
      await setGroupSetting(database, "members", "members.custom_title_max_chars", 10);

      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "",
          hideOnline: false,
          hideFromMemberList: false,
          customTitle: "Night Owl",
          values: {},
          fields: [],
        }),
      ).toMatchObject({ ok: false, code: "custom_title_not_allowed" });

      await setGroupSetting(database, "members", "members.can_custom_title", true);
      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "",
          hideOnline: false,
          hideFromMemberList: false,
          customTitle: "This title is far too long",
          values: {},
          fields: [],
        }),
      ).toMatchObject({ ok: false, code: "custom_title_too_long", limit: 10 });

      expect(
        await saveMemberProfile(database.sql, {
          memberId: member,
          aboutMd: "",
          hideOnline: false,
          hideFromMemberList: false,
          customTitle: "Night Owl",
          blockedWords: ["owl"],
          values: {},
          fields: [],
        }),
      ).toMatchObject({ ok: false, code: "blocked_word" });
    });
  }, 30_000);

  test("a rank edit does not re-render cached post blocks", async () => {
    await withDb(async (database) => {
      const { createRenderCache, createTagVersions } = await import("@bulletin/cache");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const post = {
          id: "999",
          authorId: null,
          position: 1,
          href: "/topic/1",
          authorCard: safeHtml(""),
          body: safeHtml("body"),
          files: null,
          deleted: false,
          unapproved: false,
          createdAt: "now",
          editedMarker: null,
          canEdit: false,
          editBody: null,
          canRedact: false,
          canDelete: false,
          canRestore: false,
          canHardDelete: false,
          canViewHistory: false,
        };
        const input = {
          sql: database.sql,
          cache,
          theme: null,
          post,
          loadPost: async () => post,
          visibilityKey: "test",
          locale: "en" as const,
          translate,
          pluginsGeneration: 1,
          colourScheme: "system",
          flagsHash: "flags",
          flags: {},
          tags: [],
        };
        await renderPostBlock(input);
        const hits = cache.hits;
        await saveRank(database.sql, {
          id: null,
          minPosts: 0,
          titleLabels: { en: "Newcomer", es: "Novato", fr: "Débutant" },
          pips: 1,
          imageKey: null,
        });
        const second = await renderPostBlock(input);
        expect(second).toContain("body");
        expect(cache.hits).toBe(hits + 1);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("automatic badge rules award at most once and notify the member", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const badgeId = await saveBadge(database.sql, {
        id: null,
        key: "poster",
        labels: { en: "Poster", es: "Publicador", fr: "Auteur" },
        descriptionLabels: { en: "Posts", es: "Publica", fr: "Publie" },
        imageKey: null,
        position: 0,
        rule: { type: "post_count", threshold: 1, forumId: null },
      });

      expect(
        await evaluateBadgeRulesForEvent(database.sql, {
          type: "post.approved",
          payloadIds: { authorId: member },
        }),
      ).toBe(1);
      expect(await evaluateBadgeRulesForMember(database.sql, member)).toBe(0);
      expect((await readMemberBadges(database.sql, member)).map((badge) => badge.id)).toEqual([
        badgeId,
      ]);

      const [eventRow] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'badge.awarded' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: string }>;
      expect(eventRow?.id).toMatch(/^\d+$/);

      const event = await loadEvent(database.sql, BigInt(eventRow?.id ?? "0"));

      if (event === null) {
        throw new Error("The badge award event is missing");
      }

      await createNotificationsEventHandler({ sql: database.sql })(event);
      const [notification] = (await database.sql`
        SELECT type FROM core.notifications WHERE member_id = ${member}
      `) as Array<{ type: string }>;
      expect(notification?.type).toBe("badge.awarded");

      // The nightly sweep awards the same rule to everyone else it applies to.
      const second = await memberId(database, "member-2");
      expect(await evaluateAllBadgeRules(database.sql)).toBeGreaterThan(0);
      expect((await readMemberBadges(database.sql, second)).map((badge) => badge.id)).toContain(
        badgeId,
      );
    });
  }, 30_000);

  test("staff can manage ranks and badges and manually award or revoke with logs", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-2");
      const listRanks = route("ranks.list");
      const mutateRanks = route("ranks.mutate");
      const listBadges = route("badges.list");
      const mutateBadges = route("badges.mutate");
      const memberBadges = route("members.badges.get");
      const mutateMemberBadges = route("members.badges.update");

      const createdRank = await call(database, admin, mutateRanks, {
        action: "save",
        rank: { minPosts: 5, pips: 2, titleLabels: LABELS },
      });
      expect(createdRank.status).toBe(200);
      expect(
        ((await (await call(database, admin, listRanks)).json()) as { ranks: unknown[] }).ranks,
      ).toHaveLength(1);

      const createdBadge = await call(database, admin, mutateBadges, {
        action: "save",
        badge: {
          key: "manual",
          labels: LABELS,
          descriptionLabels: LABELS,
          position: 0,
          rule: null,
        },
      });
      expect(createdBadge.status).toBe(200);
      const badge = (await createdBadge.json()) as { id: string };

      const award = await call(database, admin, mutateMemberBadges, {
        memberId: member,
        badgeId: badge.id,
        action: "award",
        reason: "Thanks",
      });
      expect(award.status).toBe(200);
      const awarded = (await (
        await authorizeStaffRoute(
          { ...memberBadges, path: `${memberBadges.path}?memberId=${member}` },
          {
            request: new Request(
              new URL(`http://staff.localhost${memberBadges.path}?memberId=${member}`),
              {
                method: "GET",
              },
            ),
            url: new URL(`http://staff.localhost${memberBadges.path}?memberId=${member}`),
            session: { memberId: admin, lastAuthAt: new Date() } as never,
            sql: database.sql,
            checks: [],
          },
        )
      ).json()) as unknown;
      expect(awarded).toMatchObject({ badges: expect.any(Array) });

      const revoke = await call(database, admin, mutateMemberBadges, {
        memberId: member,
        badgeId: badge.id,
        action: "revoke",
        reason: "Mistake",
      });
      expect(revoke.status).toBe(200);

      const log = (await database.sql`
        SELECT action FROM core.admin_log
        WHERE action IN ('rank.create', 'badge.create', 'member.badge.award', 'member.badge.revoke')
        ORDER BY id
      `) as Array<{ action: string }>;
      expect(log.map((row) => row.action)).toEqual([
        "rank.create",
        "badge.create",
        "member.badge.award",
        "member.badge.revoke",
      ]);

      expect((await call(database, member, listBadges)).status).toBe(403);
    });
  }, 30_000);

  test("badge awards and notifications run under the workers role", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-2");
      const badgeId = await saveBadge(database.sql, {
        id: null,
        key: "worker_badge",
        labels: { en: "Worker badge", es: "Insignia", fr: "Badge" },
        descriptionLabels: { en: "Worker", es: "Trabajador", fr: "Travailleur" },
        imageKey: null,
        position: 0,
        rule: { type: "post_count", threshold: 1, forumId: null },
      });
      const workerUrl = new URL(database.url);
      workerUrl.username = "workers";
      workerUrl.password = "";
      const worker = new SQL(workerUrl.toString());

      try {
        expect(await evaluateBadgeRulesForMember(worker, member)).toBe(1);
        expect((await readMemberBadges(worker, member)).map((badge) => badge.id)).toContain(
          badgeId,
        );

        const [eventRow] = (await worker`
          SELECT id FROM core.events WHERE type = 'badge.awarded' ORDER BY id DESC LIMIT 1
        `) as Array<{ id: string }>;
        const event = await loadEvent(worker, BigInt(eventRow?.id ?? "0"));

        if (event === null) {
          throw new Error("The badge event is missing");
        }

        await createNotificationsEventHandler({ sql: worker })(event);
        const [notification] = (await worker`
          SELECT type FROM core.notifications WHERE member_id = ${member}
        `) as Array<{ type: string }>;
        expect(notification?.type).toBe("badge.awarded");
      } finally {
        await worker.close();
      }
    });
  }, 30_000);

  test("a card's badge flag and badge definitions both change its cached HTML", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const badgeId = await saveBadge(database.sql, {
        id: null,
        key: "card_badge",
        labels: { en: "Card badge", es: "Insignia", fr: "Badge" },
        descriptionLabels: { en: "Card", es: "Tarjeta", fr: "Carte" },
        imageKey: null,
        position: 0,
        rule: null,
      });
      await awardBadge(database.sql, {
        memberId: member,
        badgeId,
        actorId: null,
        reason: null,
      });
      await database.sql`UPDATE core.member_badges SET featured = true WHERE member_id = ${member}`;
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = (badgesEnabled: boolean) =>
          renderMemberCards(
            database.sql,
            cache,
            [member],
            "en",
            translate,
            true,
            null,
            badgesEnabled,
          );
        const off = await render(false);
        const on = await render(true);
        expect(off.get(member)).not.toContain("Card badge");
        expect(on.get(member)).toContain("Card badge");
        expect(off.get(member)).not.toBe(on.get(member));

        await saveBadge(database.sql, {
          id: badgeId,
          key: "card_badge",
          labels: { en: "Renamed badge", es: "Insignia", fr: "Badge" },
          descriptionLabels: { en: "Card", es: "Tarjeta", fr: "Carte" },
          imageKey: null,
          position: 0,
          rule: null,
        });
        await versions.refresh();
        expect((await render(true)).get(member)).toContain("Renamed badge");

        await deleteBadge(database.sql, badgeId);
        await versions.refresh();
        expect((await render(true)).get(member)).not.toContain("Renamed badge");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("a rank edit invalidates a warmed profile", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const rankId = await saveRank(database.sql, {
        id: null,
        minPosts: 0,
        titleLabels: { en: "Rookie", es: "Novato", fr: "Débutant" },
        pips: 1,
        imageKey: null,
      });
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderProfileRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: `${member}-regular-member-one`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const first = await render();
        expect(first.kind).toBe("page");
        expect(first.html).toContain("Rookie");

        await saveRank(database.sql, {
          id: rankId,
          minPosts: 0,
          titleLabels: { en: "Veteran", es: "Veterano", fr: "Vétéran" },
          pips: 2,
          imageKey: null,
        });
        await versions.refresh();

        const second = await render();
        expect(second.kind).toBe("page");
        expect(second.cache).toBe("miss");
        expect(second.html).toContain("Veteran");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
