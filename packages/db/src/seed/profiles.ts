import { renderContent } from "@bulletin/content";
import { rebuildLeaderboards } from "@bulletin/domain/leaderboards";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

interface FieldSpec {
  readonly en: string;
  readonly es: string;
  readonly fr: string;
  readonly type: string;
  readonly options?: readonly {
    readonly value: string;
    readonly en: string;
    readonly es: string;
    readonly fr: string;
  }[];
  readonly visibleTo: readonly string[];
  readonly editableBy: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  {
    en: "Location",
    es: "Ubicación",
    fr: "Localisation",
    type: "short_text",
    visibleTo: [
      "guests",
      "members",
      "regulars",
      "vip",
      "moderators",
      "super_moderators",
      "administrators",
    ],
    editableBy: ["members", "regulars", "vip", "moderators", "super_moderators", "administrators"],
  },
  {
    en: "Pronouns",
    es: "Pronombres",
    fr: "Pronoms",
    type: "select",
    options: [
      { value: "she/her", en: "she/her", es: "ella", fr: "elle" },
      { value: "he/him", en: "he/him", es: "él", fr: "il" },
      { value: "they/them", en: "they/them", es: "elle/elles", fr: "iel" },
    ],
    visibleTo: [
      "guests",
      "members",
      "regulars",
      "vip",
      "moderators",
      "super_moderators",
      "administrators",
    ],
    editableBy: ["members", "regulars", "vip", "moderators", "super_moderators", "administrators"],
  },
  {
    en: "Moderator note",
    es: "Nota de moderación",
    fr: "Note de modération",
    type: "short_text",
    visibleTo: ["moderators", "super_moderators", "administrators"],
    editableBy: ["moderators", "super_moderators", "administrators"],
  },
];

const ABOUT: Readonly<Record<string, string>> = {
  "member-1":
    "I build small things on the web and help out around here. Ask me about CSS, accessibility or tea.",
  "member-2": "Reader, occasional gardener, and collector of mechanical keyboards.",
  "member-es": "Me gusta leer, cocinar y conversar sobre tecnología.",
  "member-fr": "Toujours curieux, parfois bavard, jamais pressé.",
};

const SIGNATURES: Readonly<Record<string, string>> = {
  "member-1": "Writing about small web things. *Be kind.*",
  "member-2": "Coffee, books, and CSS.",
  "member-es": "Leer y conversar.",
  "member-fr": "Toujours curieux.",
};

const TITLES: Readonly<Record<string, string>> = {
  "member-1": "Night Owl",
  "member-2": "Bookworm",
};

const RANKS = [
  { minPosts: 0, en: "Newcomer", es: "Novato", fr: "Débutant", pips: 1 },
  { minPosts: 10, en: "Member", es: "Miembro", fr: "Membre", pips: 2 },
  { minPosts: 100, en: "Regular", es: "Habitual", fr: "Habitué", pips: 3 },
  { minPosts: 500, en: "Veteran", es: "Veterano", fr: "Vétéran", pips: 4 },
  { minPosts: 1000, en: "Legend", es: "Leyenda", fr: "Légende", pips: 5 },
] as const;

const BADGES = [
  {
    key: "helpful",
    en: "Helpful",
    es: "Servicial",
    fr: "Serviable",
    descEn: "Always ready to help another member.",
    descEs: "Siempre dispuesto a ayudar.",
    descFr: "Toujours prêt à aider.",
  },
  {
    key: "chatter",
    en: "Chatty",
    es: "Charlatán",
    fr: "Bavard",
    descEn: "An active voice in the community.",
    descEs: "Una voz activa en la comunidad.",
    descFr: "Une voix active dans la communauté.",
  },
  {
    key: "loved",
    en: "Loved",
    es: "Querido",
    fr: "Aimé",
    descEn: "Their posts get a lot of reactions.",
    descEs: "Sus publicaciones reciben muchas reacciones.",
    descFr: "Ses messages reçoivent beaucoup de réactions.",
  },
] as const;

const PRESENCE = [
  { sub: "member-1", forum: "off-topic" },
  { sub: "member-2", forum: "general-discussion" },
  { sub: "member-es", forum: "off-topic" },
  { sub: "admin", forum: null },
] as const;

async function memberMap(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT i.sub, i.member_id::text AS member_id
    FROM pii.identities i
  `) as Array<{ sub: string; member_id: string }>;

  return new Map(rows.map((row) => [row.sub, row.member_id]));
}

async function groupMap(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`SELECT key, id::text AS id FROM core.groups`) as Array<{
    key: string;
    id: string;
  }>;

  return new Map(rows.map((row) => [row.key, row.id]));
}

async function forumMap(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`SELECT slug, id::text AS id FROM core.forums`) as Array<{
    slug: string;
    id: string;
  }>;

  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function seedFields(
  sql: SQL,
  members: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const [position, field] of FIELDS.entries()) {
    const existing = (await sql`
      SELECT id::text AS id FROM core.profile_fields WHERE labels->>'en' = ${field.en} LIMIT 1
    `) as Array<{ id: string }>;
    const id =
      existing[0]?.id ??
      (
        (await sql`
          INSERT INTO core.profile_fields (
            type, required, labels, options, position
          ) VALUES (
            ${field.type},
            false,
            ${{ en: field.en, es: field.es, fr: field.fr }}::jsonb,
            ${(field.options ?? []).map((option) => ({
              value: option.value,
              labels: { en: option.en, es: option.es, fr: option.fr },
            }))}::jsonb,
            ${position}
          )
          RETURNING id::text AS id
        `) as Array<{ id: string }>
      )[0]?.id;

    if (id === undefined) {
      continue;
    }

    ids.set(field.en, id);

    for (const key of field.visibleTo) {
      const groupId = groups.get(key);

      if (groupId === undefined) {
        continue;
      }

      await sql`
        INSERT INTO core.profile_field_groups (field_id, group_id, can_view, can_edit)
        VALUES (${id}, ${groupId}, true, ${field.editableBy.includes(key)})
        ON CONFLICT (field_id, group_id) DO UPDATE
          SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit
      `;
    }
  }

  const values: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    "member-1": {
      Location: "The Netherlands",
      Pronouns: "they/them",
      "Moderator note": "Seeded staff-only note",
    },
    "member-2": { Location: "Lisbon", Pronouns: "she/her" },
    "member-es": { Location: "Madrid", Pronouns: "she/her" },
    "member-fr": { Location: "Lyon", Pronouns: "he/him" },
  };

  for (const [sub, fields] of Object.entries(values)) {
    const memberId = members.get(sub);

    if (memberId === undefined) {
      continue;
    }

    for (const [label, value] of Object.entries(fields)) {
      const fieldId = ids.get(label);

      if (fieldId === undefined) {
        continue;
      }

      await sql`
        INSERT INTO core.member_field_values (member_id, field_id, value)
        VALUES (${memberId}, ${fieldId}, ${value}::jsonb)
        ON CONFLICT (member_id, field_id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
    }
  }

  return ids;
}

/** Rich local-development data for every member-profiles surface (task 6.2). */
export const profilesSeedModule: SeedModule = {
  name: "profiles",
  dependsOn: ["members", "topics"],
  async run({ sql }) {
    const [members, groups, forums] = await Promise.all([
      memberMap(sql),
      groupMap(sql),
      forumMap(sql),
    ]);
    await seedFields(sql, members, groups);

    const now = new Date();

    for (const [sub, markdown] of Object.entries(ABOUT)) {
      const memberId = members.get(sub);

      if (memberId === undefined) {
        continue;
      }

      const rendered = await renderContent(markdown, {
        profile: "about",
        context: { kind: "forum_post", forumId: "0" },
        authorId: memberId,
      });
      await sql`
        UPDATE core.members
        SET about_md = ${rendered.bodyMd}, about_html = ${rendered.bodyHtml}
        WHERE id = ${memberId}
      `;
    }

    for (const [sub, markdown] of Object.entries(SIGNATURES)) {
      const memberId = members.get(sub);

      if (memberId === undefined) {
        continue;
      }

      const rendered = await renderContent(markdown, {
        profile: "signature",
        context: { kind: "forum_post", forumId: "0" },
        authorId: memberId,
      });
      await sql`
        UPDATE core.members
        SET signature_md = ${rendered.bodyMd},
            signature_html = ${rendered.bodyHtml},
            signature_updated_at = ${now}
        WHERE id = ${memberId}
      `;
    }

    for (const [sub, title] of Object.entries(TITLES)) {
      const memberId = members.get(sub);

      if (memberId !== undefined) {
        await sql`UPDATE core.members SET custom_title = ${title} WHERE id = ${memberId}`;
      }
    }

    for (const rank of RANKS) {
      await sql`
        INSERT INTO core.ranks (min_posts, title_labels, pips)
        VALUES (
          ${rank.minPosts},
          ${{ en: rank.en, es: rank.es, fr: rank.fr }}::jsonb,
          ${rank.pips}
        )
        ON CONFLICT (min_posts) DO UPDATE
          SET title_labels = EXCLUDED.title_labels, pips = EXCLUDED.pips, updated_at = now()
      `;
    }

    const badgeIds = new Map<string, string>();

    for (const [position, badge] of BADGES.entries()) {
      const [row] = (await sql`
        INSERT INTO core.badges (key, labels, description_labels, position)
        VALUES (
          ${badge.key},
          ${{ en: badge.en, es: badge.es, fr: badge.fr }}::jsonb,
          ${{ en: badge.descEn, es: badge.descEs, fr: badge.descFr }}::jsonb,
          ${position}
        )
        ON CONFLICT (key) DO UPDATE
          SET labels = EXCLUDED.labels,
              description_labels = EXCLUDED.description_labels,
              position = EXCLUDED.position
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (row !== undefined) {
        badgeIds.set(badge.key, row.id);
      }
    }

    if (badgeIds.size > 0) {
      await sql`
        INSERT INTO core.badge_rules (badge_id, type, threshold)
        VALUES (${badgeIds.get("chatter") ?? "0"}, 'post_count', 50)
        ON CONFLICT (badge_id) DO UPDATE SET type = EXCLUDED.type, threshold = EXCLUDED.threshold
      `;
      await sql`
        INSERT INTO core.badge_rules (badge_id, type, threshold)
        VALUES (${badgeIds.get("loved") ?? "0"}, 'reactions_received', 5)
        ON CONFLICT (badge_id) DO UPDATE SET type = EXCLUDED.type, threshold = EXCLUDED.threshold
      `;
    }

    const award = async (sub: string, key: string, featured: boolean): Promise<void> => {
      const memberId = members.get(sub);
      const badgeId = badgeIds.get(key);

      if (memberId === undefined || badgeId === undefined) {
        return;
      }

      await sql`
        INSERT INTO core.member_badges (member_id, badge_id, featured)
        VALUES (${memberId}, ${badgeId}, ${featured})
        ON CONFLICT (member_id, badge_id) DO UPDATE SET featured = EXCLUDED.featured
      `;
    };

    await award("member-1", "helpful", true);
    await award("member-2", "helpful", true);
    await award("member-1", "chatter", true);
    await award("member-2", "chatter", false);
    await award("member-1", "loved", false);
    await award("member-es", "chatter", false);

    const ignored = members.get("account-member");
    const ignoredTarget = members.get("warned-member");

    if (ignored !== undefined && ignoredTarget !== undefined) {
      await sql`
        INSERT INTO core.member_ignores (member_id, ignored_id)
        VALUES (${ignored}, ${ignoredTarget})
        ON CONFLICT DO NOTHING
      `;
    }

    const friendPairs: readonly (readonly [string, string])[] = [
      ["member-1", "account-member"],
      ["member-2", "member-es"],
    ];

    for (const [firstSub, secondSub] of friendPairs) {
      const first = members.get(firstSub);
      const second = members.get(secondSub);

      if (first === undefined || second === undefined) {
        continue;
      }

      const [a, b] = BigInt(first) < BigInt(second) ? [first, second] : [second, first];

      await sql`
        INSERT INTO core.friendships (a_member_id, b_member_id, state, requested_by)
        VALUES (${a}, ${b}, 'accepted', ${first})
        ON CONFLICT (a_member_id, b_member_id) DO NOTHING
      `;
    }

    const guestIds = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
    ];

    for (const presence of PRESENCE) {
      const memberId = members.get(presence.sub);

      if (memberId === undefined) {
        continue;
      }

      const forum = presence.forum === null ? null : forums.get(presence.forum);
      await sql`
        INSERT INTO core.presence (viewer_key, location, last_seen)
        VALUES (${`member:${memberId}`}, ${forum === undefined || forum === null ? "board" : `forum:${forum}`}, ${now})
        ON CONFLICT (viewer_key) DO UPDATE
          SET location = EXCLUDED.location, last_seen = EXCLUDED.last_seen
      `;
    }

    for (const guestId of guestIds) {
      await sql`
        INSERT INTO core.presence (viewer_key, location, last_seen)
        VALUES (${`guest:${guestId}`}, 'board', ${now})
        ON CONFLICT (viewer_key) DO UPDATE
          SET location = EXCLUDED.location, last_seen = EXCLUDED.last_seen
      `;
    }

    await rebuildLeaderboards(sql, now);
  },
};
