import { renderContent } from "@bulletin/content";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

interface PrefixSeed {
  readonly key: string;
  readonly colour: string;
  readonly labels: Readonly<Record<"en" | "es" | "fr", string>>;
  readonly groupKeys?: readonly string[];
}

const PREFIXES: readonly PrefixSeed[] = [
  {
    key: "question",
    colour: "#3157c7",
    labels: { en: "Question", es: "Pregunta", fr: "Question" },
  },
  {
    key: "solved",
    colour: "#2f855a",
    labels: { en: "Solved", es: "Resuelto", fr: "Résolu" },
  },
  {
    key: "bug",
    colour: "#a02a2a",
    labels: { en: "Bug", es: "Error", fr: "Anomalie" },
  },
  {
    key: "escalated",
    colour: "#7d3fc4",
    labels: { en: "Escalated", es: "Escalado", fr: "Escaladé" },
    groupKeys: ["moderators", "super_moderators", "administrators"],
  },
];

const FORUM_PREFIXES: Readonly<
  Record<
    string,
    { readonly prefixes: readonly string[]; readonly mode: "none" | "optional" | "required" }
  >
> = {
  "general-discussion": { prefixes: ["question", "solved"], mode: "optional" },
  "help-questions": { prefixes: ["question", "solved", "bug"], mode: "required" },
  "resolved-topics": { prefixes: ["solved"], mode: "optional" },
  "bug-reports": { prefixes: ["bug"], mode: "optional" },
  "site-feedback": { prefixes: ["question", "bug"], mode: "optional" },
  "staff-room": { prefixes: ["escalated"], mode: "optional" },
};

async function forumIds(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`SELECT id, slug FROM core.forums`) as Array<{
    id: string;
    slug: string;
  }>;
  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function groupIds(sql: SQL): Promise<Map<string, string>> {
  const rows = (await sql`SELECT id, key FROM core.groups`) as Array<{
    id: string;
    key: string;
  }>;
  return new Map(rows.map((row) => [row.key, row.id]));
}

async function seedPrefixes(sql: SQL): Promise<void> {
  const forums = await forumIds(sql);
  const groups = await groupIds(sql);
  const prefixIds = new Map<string, string>();

  for (const [index, prefix] of PREFIXES.entries()) {
    const [row] = (await sql`
      INSERT INTO core.prefixes (key, colour, display_order)
      VALUES (${prefix.key}, ${prefix.colour}, ${index})
      ON CONFLICT (key) DO UPDATE
        SET colour = EXCLUDED.colour, display_order = EXCLUDED.display_order
      RETURNING id
    `) as Array<{ id: string }>;

    if (row === undefined) {
      throw new Error(`Could not seed prefix ${prefix.key}`);
    }

    prefixIds.set(prefix.key, row.id);
    await sql`DELETE FROM core.prefix_labels WHERE prefix_id = ${row.id}`;

    for (const locale of ["en", "es", "fr"] as const) {
      await sql`
        INSERT INTO core.prefix_labels (prefix_id, locale, label)
        VALUES (${row.id}, ${locale}, ${prefix.labels[locale]})
      `;
    }

    await sql`DELETE FROM core.prefix_groups WHERE prefix_id = ${row.id}`;

    for (const key of prefix.groupKeys ?? []) {
      const groupId = groups.get(key);

      if (groupId === undefined) {
        throw new Error(`Unknown prefix group ${key}`);
      }

      await sql`
        INSERT INTO core.prefix_groups (prefix_id, group_id) VALUES (${row.id}, ${groupId})
      `;
    }
  }

  for (const [slug, config] of Object.entries(FORUM_PREFIXES)) {
    const forumId = forums.get(slug);

    if (forumId === undefined) {
      throw new Error(`Unknown prefix forum ${slug}`);
    }

    await sql`DELETE FROM core.forum_prefixes WHERE forum_id = ${forumId}`;

    for (const [position, key] of config.prefixes.entries()) {
      const prefixId = prefixIds.get(key);

      if (prefixId === undefined) {
        throw new Error(`Unknown prefix ${key}`);
      }

      await sql`
        INSERT INTO core.forum_prefixes (forum_id, prefix_id, position)
        VALUES (${forumId}, ${prefixId}, ${position})
      `;
    }

    await sql`UPDATE core.forums SET prefix_mode = ${config.mode} WHERE id = ${forumId}`;
  }
}

async function seedAnnouncements(sql: SQL): Promise<void> {
  const forums = await forumIds(sql);
  const groups = await groupIds(sql);

  async function announcement(input: {
    readonly title: string;
    readonly body: string;
    readonly scope: "global" | "forums";
    readonly startsHoursAgo: number;
    readonly endsInHours?: number;
    readonly dismissible?: boolean;
    readonly forumSlug?: string;
    readonly includeSubforums?: boolean;
    readonly groupKeys?: readonly string[];
  }): Promise<void> {
    const now = Date.now();
    const startsAt = new Date(now - input.startsHoursAgo * 60 * 60 * 1_000);
    const endsAt =
      input.endsInHours === undefined ? null : new Date(now + input.endsInHours * 60 * 60 * 1_000);
    const renderedBody = await renderContent(input.body, {
      profile: "rules",
      context: { kind: "forum_post", forumId: "1" },
      authorId: "0",
    });
    const [row] = (await sql`
      INSERT INTO core.announcements (
        title, body, body_html, body_text, render_version, sanitiser_version,
        scope, starts_at, ends_at, dismissible
      )
      VALUES (
        ${input.title}, ${renderedBody.bodyMd}, ${renderedBody.bodyHtml},
        ${renderedBody.bodyText}, ${renderedBody.renderVersion},
        ${renderedBody.sanitiserVersion}, ${input.scope},
        ${startsAt}, ${endsAt}, ${input.dismissible ?? true}
      )
      RETURNING id
    `) as Array<{ id: string }>;

    if (row === undefined) {
      throw new Error(`Could not seed announcement ${input.title}`);
    }

    if (input.forumSlug !== undefined) {
      const forumId = forums.get(input.forumSlug);

      if (forumId === undefined) {
        throw new Error(`Unknown announcement forum ${input.forumSlug}`);
      }

      await sql`
        INSERT INTO core.announcement_targets (announcement_id, forum_id, include_subforums)
        VALUES (${row.id}, ${forumId}, ${input.includeSubforums ?? false})
      `;
    }

    for (const key of input.groupKeys ?? []) {
      const groupId = groups.get(key);

      if (groupId === undefined) {
        throw new Error(`Unknown announcement group ${key}`);
      }

      await sql`
        INSERT INTO core.announcement_groups (announcement_id, group_id)
        VALUES (${row.id}, ${groupId})
      `;
    }
  }

  await announcement({
    title: "Welcome to Bulletin",
    body: "Be kind, read the community guidelines and introduce yourself. If anything is unclear, ask in Help & Questions.",
    scope: "global",
    startsHoursAgo: 24,
  });
  await announcement({
    title: "Upcoming maintenance",
    body: "The board will be briefly unavailable while we apply upgrades. Thanks for your patience.",
    scope: "global",
    startsHoursAgo: -48,
    endsInHours: 72,
    dismissible: false,
  });
  await announcement({
    title: "How to ask for help",
    body: "Include what you tried, what you expected and what happened. Screenshots help if they do not contain private data.",
    scope: "forums",
    forumSlug: "support",
    includeSubforums: true,
    startsHoursAgo: 12,
  });
  await announcement({
    title: "VIP update",
    body: "A VIP-only preview of the next community features is available in Announcements.",
    scope: "forums",
    forumSlug: "announcements",
    groupKeys: ["vip"],
    startsHoursAgo: 6,
  });
  await announcement({
    title: "Staff briefing",
    body: "Review the moderation queue before the weekend and leave notes in Moderation Notes.",
    scope: "forums",
    forumSlug: "staff-area",
    includeSubforums: true,
    groupKeys: ["administrators", "super_moderators"],
    startsHoursAgo: 3,
  });
}

/** Prefixes, per-forum prefix sets and the seeded announcements. */
export const forumExtrasSeedModule: SeedModule = {
  name: "forum-extras",
  dependsOn: ["forums", "groups"],
  async run({ sql }) {
    await seedPrefixes(sql);
    await seedAnnouncements(sql);
  },
};
