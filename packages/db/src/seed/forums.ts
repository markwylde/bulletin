import { renderContent } from "@bulletin/content";
import { hashForumPassword } from "@bulletin/domain/permissions";
import { FIXTURE_DEMO_PASSWORD } from "@bulletin/domain/permissions/fixtures";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

interface ForumSeed {
  readonly slug: string;
  readonly title: string;
  readonly type?: "category" | "forum" | "redirect";
  readonly parentSlug?: string;
  readonly description?: string;
  readonly rules?: string;
  readonly redirectUrl?: string;
  readonly password?: boolean;
  readonly topicCount?: number;
  readonly postCount?: number;
  readonly lastPostHoursAgo?: number;
  readonly language?: string;
}

/**
 * The board's structure: four categories and fifteen forums, three levels deep, including a
 * password forum, a redirect forum and a staff-only branch. The first four rows keep the ids
 * and core slugs the permission fixtures and demo route have always used, so permissions and
 * the demo remain stable while the rest of the board becomes realistic seed data.
 */
const FORUMS: readonly ForumSeed[] = [
  {
    slug: "community",
    title: "Community",
    type: "category",
    description: "General discussion for everyone on the board.",
  },
  {
    slug: "announcements",
    title: "Announcements",
    parentSlug: "community",
    description: "Board news, maintenance notices and community updates.",
    rules: "Be kind. No spam, and keep support topics on topic.",
    topicCount: 8,
    postCount: 42,
    lastPostHoursAgo: 2,
  },
  {
    slug: "general-discussion",
    title: "General Discussion",
    parentSlug: "community",
    description: "The place for everyday conversation.",
    password: true,
    topicCount: 24,
    postCount: 318,
    lastPostHoursAgo: 1,
  },
  {
    slug: "introductions",
    title: "Introductions",
    parentSlug: "general-discussion",
    description: "Say hello and tell us what brought you here.",
    topicCount: 6,
    postCount: 31,
    lastPostHoursAgo: 5,
  },
  {
    slug: "off-topic",
    title: "Off Topic",
    parentSlug: "community",
    description: "Hobbies, links and everything that is not forum business.",
    topicCount: 17,
    postCount: 203,
    lastPostHoursAgo: 4,
  },
  {
    slug: "guidelines",
    title: "Community Guidelines",
    parentSlug: "community",
    description: "Read this before posting; it explains how we treat each other.",
    topicCount: 2,
    postCount: 2,
  },
  {
    slug: "support",
    title: "Support",
    type: "category",
    description: "Help with the board and with Bulletin itself.",
  },
  {
    slug: "help-questions",
    title: "Help & Questions",
    parentSlug: "support",
    description: "Ask the community for help with anything Bulletin-related.",
    topicCount: 31,
    postCount: 187,
    lastPostHoursAgo: 1,
  },
  {
    slug: "resolved-topics",
    title: "Resolved Topics",
    parentSlug: "help-questions",
    description: "Answered questions kept for future readers.",
    topicCount: 54,
    postCount: 260,
  },
  {
    slug: "bug-reports",
    title: "Bug Reports",
    parentSlug: "support",
    description: "Report reproducible problems with the board.",
    topicCount: 15,
    postCount: 94,
    lastPostHoursAgo: 3,
  },
  {
    slug: "site-feedback",
    title: "Site Feedback",
    parentSlug: "support",
    description: "Suggestions for making the community better.",
    topicCount: 9,
    postCount: 67,
  },
  {
    slug: "offsite-handbook",
    title: "Community Handbook",
    parentSlug: "support",
    type: "redirect",
    description: "The full guide lives on our handbook site.",
    redirectUrl: "https://example.com/handbook",
  },
  {
    slug: "staff-area",
    title: "Staff Area",
    type: "category",
    description: "Private staff planning; visible to administrators and super moderators.",
  },
  {
    slug: "staff-room",
    title: "Staff Room",
    parentSlug: "staff-area",
    description: "Coordination and daily staff conversation.",
    topicCount: 12,
    postCount: 88,
  },
  {
    slug: "moderation-notes",
    title: "Moderation Notes",
    parentSlug: "staff-room",
    description: "Patterns, warnings and moderation decisions worth remembering.",
    topicCount: 7,
    postCount: 35,
  },
  {
    slug: "archive",
    title: "Archive",
    type: "category",
    description: "Older discussions kept for reference.",
  },
  {
    slug: "archived-announcements",
    title: "Archived Announcements",
    parentSlug: "archive",
    description: "Past board notices, kept read-only in spirit.",
    language: "en",
  },
  {
    slug: "retired-support",
    title: "Retired Support",
    parentSlug: "archive",
    description: "Support threads from earlier versions of the board.",
    topicCount: 44,
    postCount: 210,
  },
  {
    slug: "technical-archive",
    title: "Technical Archive",
    parentSlug: "archive",
    description: "Historical notes about hosting, migrations and upgrades.",
    topicCount: 11,
    postCount: 40,
  },
];

interface ForumRow {
  readonly id: string;
}

async function insertForum(
  sql: SQL,
  seed: ForumSeed,
  parentId: string | null,
  passwordHash: string | null,
  position: number,
): Promise<string> {
  const renderedRules = await renderContent(seed.rules ?? "", {
    profile: "rules",
    context: { kind: "forum_post", forumId: "1" },
    authorId: "0",
  });
  const [row] = (await sql`
    INSERT INTO core.forums (
      parent_id, type, title, slug, description, rules,
      rules_html, rules_text, rules_render_version, rules_sanitiser_version,
      redirect_url, password_hash,
      position, topic_count, post_count, last_post_at, language
    )
    VALUES (
      ${parentId}, ${seed.type ?? "forum"}, ${seed.title}, ${seed.slug},
      ${seed.description ?? ""}, ${renderedRules.bodyMd},
      ${renderedRules.bodyHtml}, ${renderedRules.bodyText},
      ${renderedRules.renderVersion}, ${renderedRules.sanitiserVersion},
      ${seed.redirectUrl ?? null},
      ${passwordHash}, ${position}, ${seed.topicCount ?? 0}, ${seed.postCount ?? 0},
      ${
        seed.lastPostHoursAgo === undefined
          ? null
          : new Date(Date.now() - seed.lastPostHoursAgo * 60 * 60 * 1_000)
      },
      ${seed.language ?? null}
    )
    RETURNING id
  `) as ForumRow[];

  if (row === undefined) {
    throw new Error(`Could not seed forum ${seed.slug}`);
  }

  return row.id;
}

export const forumSeedModule: SeedModule = {
  name: "forums",
  dependsOn: ["base"],
  async run({ sql }) {
    const existing = (await sql`SELECT 1 FROM core.forums LIMIT 1`) as unknown[];

    if (existing.length > 0) {
      return;
    }

    const ids = new Map<string, string>();
    const passwordHash = await hashForumPassword(FIXTURE_DEMO_PASSWORD);

    for (const [index, seed] of FORUMS.entries()) {
      const parentId = seed.parentSlug === undefined ? null : (ids.get(seed.parentSlug) ?? null);

      if (seed.parentSlug !== undefined && parentId === null) {
        throw new Error(`Forum ${seed.slug} has unknown parent ${seed.parentSlug}`);
      }

      const id = await insertForum(
        sql,
        seed,
        parentId,
        seed.password === true ? passwordHash : null,
        index,
      );
      ids.set(seed.slug, id);
    }
  },
};
