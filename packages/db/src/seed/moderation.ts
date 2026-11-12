import { renderContent } from "@bulletin/content";
import { loadReplaceWords } from "@bulletin/domain/filters";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

interface MemberIds {
  readonly [sub: string]: string;
}

async function mapMembers(sql: SQL): Promise<MemberIds> {
  const rows = (await sql`
    SELECT sub, member_id::text AS id FROM pii.identities
  `) as Array<{ sub: string; id: string }>;

  return Object.fromEntries(rows.map((row) => [row.sub, row.id]));
}

async function mapForums(sql: SQL): Promise<Record<string, string>> {
  const rows = (await sql`
    SELECT slug, id::text AS id FROM core.forums
  `) as Array<{ slug: string; id: string }>;

  return Object.fromEntries(rows.map((row) => [row.slug, row.id]));
}

async function seedFilters(sql: SQL): Promise<void> {
  const words = [
    { word: "damn", mode: "replace", replacement: "****", match_mode: "whole" },
    { word: "crap", mode: "replace", replacement: "[redacted]", match_mode: "any" },
    { word: "badword", mode: "block", replacement: "", match_mode: "whole" },
  ] as const;

  for (const word of words) {
    await sql`
      INSERT INTO core.filter_words (word, mode, replacement, match_mode, enabled)
      VALUES (${word.word}, ${word.mode}, ${word.replacement}, ${word.match_mode}, true)
      ON CONFLICT DO NOTHING
    `;
  }

  await sql`
    INSERT INTO core.filter_domains (domain, enabled)
    VALUES ('spam.example', true) ON CONFLICT (domain) DO NOTHING
  `;
  await sql`
    UPDATE core.filter_settings
    SET version = version + 1, duplicate_enabled = true, duplicate_count = 2,
        rate_enabled = true, rate_count = 5, rate_minutes = 1
    WHERE id = 1
  `;
}

async function seedHeldPost(
  sql: SQL,
  ids: MemberIds,
  forums: Record<string, string>,
): Promise<void> {
  const authorId = ids["new-member"];
  const forumId = forums["off-topic"];

  if (authorId === undefined || forumId === undefined) {
    throw new Error("Missing moderation seed members/forums");
  }

  const replaceWords = await loadReplaceWords(sql);
  const rendered = await renderContent(
    "A first introduction from a new member. This one has a damn swear word to demonstrate the replace filter.",
    {
      profile: "post",
      context: { kind: "forum_post", forumId },
      authorId,
      replaceWords,
    },
  );
  const [topic] = (await sql`
    INSERT INTO core.topics (
      forum_id, title, slug, starter_id, visibility, hold_reason
    )
    VALUES (
      ${forumId}, 'New member introduction awaiting approval',
      'new-member-introduction-awaiting-approval', ${authorId}, 'unapproved', 'new_member'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not seed the held topic");
  }

  const [post] = (await sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, visibility, hold_reason, position
    )
    VALUES (
      ${topic.id}, ${authorId}, ${rendered.bodyMd}, ${rendered.bodyHtml},
      ${rendered.bodyText}, ${rendered.renderVersion}, ${rendered.sanitiserVersion},
      'unapproved', 'new_member', 1
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  await sql`
    UPDATE core.topics
    SET first_post_id = ${post?.id ?? null}, last_post_id = ${post?.id ?? null},
        updated_at = now()
    WHERE id = ${topic.id}
  `;
}

async function seedReports(
  sql: SQL,
  ids: MemberIds,
  forums: Record<string, string>,
): Promise<void> {
  const forumId = forums["off-topic"];
  const reporterA = ids["member-1"];
  const reporterB = ids["member-fr"];
  const moderator = ids["super-mod"];

  if (
    forumId === undefined ||
    reporterA === undefined ||
    reporterB === undefined ||
    moderator === undefined
  ) {
    throw new Error("Missing moderation report seed data");
  }

  const [targetPost] = (await sql`
    SELECT p.id::text AS id
    FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
    WHERE t.forum_id = ${forumId} AND p.author_id IS NOT NULL
    ORDER BY p.id
    LIMIT 1
  `) as Array<{ id: string }>;

  if (targetPost !== undefined) {
    const [report] = (await sql`
      INSERT INTO core.reports (target_type, target_id, status, created_at, updated_at)
      VALUES ('post', ${targetPost.id}, 'open', now() - interval '2 hours', now() - interval '90 minutes')
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (report !== undefined) {
      await sql`
        INSERT INTO core.report_reporters (report_id, reporter_id, reason, comment)
        VALUES
          (${report.id}, ${reporterA}, 'spam', 'This looks like spam.'),
          (${report.id}, ${reporterB}, 'abuse', 'The tone is abusive.')
      `;
      await sql`
        INSERT INTO core.report_comments (report_id, actor_id, body, created_at)
        VALUES (${report.id}, ${moderator}, 'Reviewing this now.', now() - interval '1 hour')
      `;
    }
  }

  const targetMember = ids["member-es"];

  if (targetMember !== undefined) {
    await sql`
      INSERT INTO core.reports (
        target_type, target_id, status, assignee_id, created_at, updated_at, resolved_at
      )
      VALUES (
        'member', ${targetMember}, 'resolved', ${moderator},
        now() - interval '3 days', now() - interval '2 days', now() - interval '2 days'
      )
    `;
  }

  // A PM report shows the reported message and the one before it, and holds both.
  const [conversation] = (await sql`
    SELECT id::text AS id FROM core.conversations
    WHERE title = 'Photo walk' ORDER BY id LIMIT 1
  `) as Array<{ id: string }>;

  if (conversation === undefined) {
    return;
  }

  const messages = (await sql`
    SELECT id::text AS id FROM core.conversation_messages
    WHERE conversation_id = ${conversation.id} ORDER BY id
  `) as Array<{ id: string }>;
  const reported = messages.at(-1)?.id;

  if (reported === undefined) {
    return;
  }

  const [pmReport] = (await sql`
    INSERT INTO core.reports (
      target_type, target_id, status, created_at, updated_at
    )
    VALUES ('pm', ${reported}, 'open', now() - interval '1 hour', now() - interval '20 minutes')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (pmReport === undefined) {
    return;
  }

  await sql`
    INSERT INTO core.report_reporters (report_id, reporter_id, reason, comment)
    VALUES (${pmReport.id}, ${reporterA}, 'abuse', 'This private message crossed a line.')
  `;

  for (const [position, message] of messages.slice(-2).entries()) {
    await sql`
      INSERT INTO core.report_pm_access (report_id, message_id, position)
      VALUES (${pmReport.id}, ${message.id}, ${position})
    `;
    await sql`
      INSERT INTO core.conversation_message_holds (message_id, holder, ref)
      VALUES (${message.id}, 'report', ${pmReport.id})
      ON CONFLICT DO NOTHING
    `;
  }
}

async function seedWarnings(sql: SQL, ids: MemberIds): Promise<void> {
  const reasons = [
    { key: "spam", points: 3, days: 30, labels: { en: "Spam", es: "Spam", fr: "Spam" } },
    { key: "abuse", points: 5, days: 14, labels: { en: "Abuse", es: "Abuso", fr: "Abus" } },
    {
      key: "courtesy",
      points: 1,
      days: 7,
      labels: { en: "Courtesy", es: "Cortesía", fr: "Courtoisie" },
    },
  ] as const;
  const reasonIds = new Map<string, string>();

  for (const reason of reasons) {
    const [row] = (await sql`
      INSERT INTO core.warning_reasons (key, points, expiry_days, allow_points_override, position)
      VALUES (${reason.key}, ${reason.points}, ${reason.days}, ${reason.key === "courtesy"}, ${reason.points})
      ON CONFLICT (key) DO UPDATE SET updated_at = now()
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (row !== undefined) {
      reasonIds.set(reason.key, row.id);

      for (const locale of ["en", "es", "fr"] as const) {
        await sql`
          INSERT INTO core.warning_reason_labels (reason_id, locale, label)
          VALUES (${row.id}, ${locale}, ${reason.labels[locale]})
          ON CONFLICT (reason_id, locale) DO UPDATE SET label = EXCLUDED.label
        `;
      }
    }
  }

  for (const threshold of [
    { points: 3, action: "mod_queue", hours: 24 },
    { points: 5, action: "suspend", hours: 168 },
    { points: 12, action: "ban", hours: null },
  ] as const) {
    const existing = (await sql`
      SELECT 1 FROM core.warning_thresholds
      WHERE points = ${threshold.points} AND action = ${threshold.action}
    `) as unknown[];

    if (existing.length === 0) {
      await sql`
        INSERT INTO core.warning_thresholds (points, action, duration_hours)
        VALUES (${threshold.points}, ${threshold.action}, ${threshold.hours})
      `;
    }
  }

  const member = ids["warned-member"];
  const moderator = ids["super-mod"];
  const abuse = reasonIds.get("abuse");

  if (member === undefined || moderator === undefined || abuse === undefined) {
    return;
  }

  const [warning] = (await sql`
    INSERT INTO core.warnings (
      member_id, reason_id, points, expires_at, content_type, content_id,
      member_note, staff_note, ack_required, issued_by, created_at
    )
    VALUES (
      ${member}, ${abuse}, 5, now() + interval '13 days', NULL, NULL,
      'Please keep discussions civil.', 'Third reminder this month.', true, ${moderator},
      now() - interval '1 day'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (warning !== undefined) {
    await sql`
      INSERT INTO core.member_restrictions (member_id, kind, until, source_warning_id)
      VALUES (${member}, 'cannot_post', now() + interval '7 days', ${warning.id})
      ON CONFLICT (member_id, kind) DO UPDATE SET until = EXCLUDED.until,
        source_warning_id = EXCLUDED.source_warning_id, created_at = now()
    `;
    await sql`
      INSERT INTO core.member_restrictions (member_id, kind, until, source_warning_id)
      VALUES (${member}, 'posts_require_approval', now() + interval '1 day', ${warning.id})
      ON CONFLICT (member_id, kind) DO UPDATE SET until = EXCLUDED.until,
        source_warning_id = EXCLUDED.source_warning_id, created_at = now()
    `;
  }
}

async function seedBans(sql: SQL, ids: MemberIds): Promise<void> {
  const moderator = ids["admin"];

  await sql`
    INSERT INTO core.ip_bans (cidr, reason, expires_at, created_by)
    VALUES ('203.0.113.0/24', 'Seeded abusive network', now() + interval '1 year', ${moderator ?? null})
    ON CONFLICT (cidr) DO NOTHING
  `;

  const member = ids["banned-member"];
  const membersGroup = (await sql`
    SELECT id::text AS id FROM core.groups WHERE key = 'members'
  `) as Array<{ id: string }>;

  if (member !== undefined && membersGroup[0] !== undefined) {
    await sql`
      INSERT INTO core.member_bans (member_id, reason, expires_at, previous_groups, created_by)
      VALUES (
        ${member}, 'Seeded permanent ban for abusive behaviour', NULL,
        ${JSON.stringify([{ group_id: membersGroup[0].id, is_primary: true }])}::text::jsonb,
        ${moderator ?? null}
      )
      ON CONFLICT (member_id) DO NOTHING
    `;
  }
}

async function seedMultimod(sql: SQL, forums: Record<string, string>): Promise<void> {
  const forumId = forums["help-questions"];

  if (forumId === undefined) {
    return;
  }

  const [prefix] = (await sql`
    SELECT id::text AS id FROM core.prefixes WHERE key = 'solved'
  `) as Array<{ id: string }>;
  const steps = [
    ...(prefix === undefined ? [] : [{ type: "prefix", prefixId: prefix.id }]),
    { type: "lock", locked: true },
    { type: "reply", bodyMd: "Marked as solved", authorId: null },
  ];

  await sql`
    INSERT INTO core.multimod_actions (name, forum_ids, steps)
    VALUES (
      'Mark solved', ${`{${forumId}}`}::bigint[],
      (${JSON.stringify(steps)}::text)::jsonb
    )
    ON CONFLICT (name) DO NOTHING
  `;
}

async function seedLog(sql: SQL, ids: MemberIds, forums: Record<string, string>): Promise<void> {
  const admin = ids["admin"];
  const member = ids["member-es"];
  const forum = forums["off-topic"];

  if (admin === undefined) {
    return;
  }

  const entries = [
    { action: "topic.pin", targetType: "topic", details: { pinned: true } },
    {
      action: "topic.merge",
      targetType: "topic",
      details: { sourceTopicIds: [], destinationTopicId: null },
    },
    { action: "warning.issue", targetType: "warning", details: { points: 5 } },
    { action: "member.ban", targetType: "member", details: { reason: "Seeded ban" } },
    { action: "ip.ban", targetType: "ip_ban", details: { cidr: "203.0.113.0/24" } },
    { action: "report.status", targetType: "report", details: { to: "resolved" } },
  ] as const;

  for (const [index, entry] of entries.entries()) {
    await sql`
      INSERT INTO core.moderation_log (
        actor_member_id, action, target_type, target_id, forum_id, member_id, summary, created_at
      )
      VALUES (
        ${admin}, ${entry.action}, ${entry.targetType}, ${member ?? null}, ${forum ?? null},
        ${member ?? null}, (${JSON.stringify(entry.details)}::text)::jsonb,
        now() - make_interval(mins => ${index * 10})
      )
    `;
  }
}

/** Seed moderation examples: held content, reports, warnings, bans, filters and actions. */
export const moderationSeedModule: SeedModule = {
  name: "moderation",
  dependsOn: ["forums", "forum-extras", "groups", "members", "topics", "conversations"],
  async run({ sql }) {
    const ids = await mapMembers(sql);
    const forums = await mapForums(sql);

    await seedFilters(sql);
    await seedHeldPost(sql, ids, forums);
    await seedReports(sql, ids, forums);
    await seedWarnings(sql, ids);
    await seedBans(sql, ids);
    await seedMultimod(sql, forums);
    await seedLog(sql, ids, forums);
  },
};
