import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { emit } from "../events/outbox.ts";
import { runMutation } from "../mutations/index.ts";
import { badgeMutation } from "../mutations/members.ts";

export const BADGE_RULE_TYPES = [
  "post_count",
  "reputation",
  "days_joined",
  "reactions_received",
  "topics_started",
  "posts_in_forum",
] as const;

export type BadgeRuleType = (typeof BADGE_RULE_TYPES)[number];

export const BADGE_RULE_LABEL_KEYS: Readonly<Record<BadgeRuleType, string>> = {
  post_count: "staff.badges.rule.postCount",
  reputation: "staff.badges.rule.reputation",
  days_joined: "staff.badges.rule.daysJoined",
  reactions_received: "staff.badges.rule.reactionsReceived",
  topics_started: "staff.badges.rule.topicsStarted",
  posts_in_forum: "staff.badges.rule.postsInForum",
};

export interface BadgeRule {
  readonly type: BadgeRuleType;
  readonly threshold: number;
  readonly forumId: string | null;
}

export interface BadgeRecord {
  readonly id: string;
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly descriptionLabels: Readonly<Record<string, string>>;
  readonly imageKey: string | null;
  readonly position: number;
  readonly rule: BadgeRule | null;
}

export interface BadgeInput {
  readonly id: string | null;
  readonly key: string;
  readonly labels: Readonly<Record<Locale, string>>;
  readonly descriptionLabels: Readonly<Record<Locale, string>>;
  readonly imageKey: string | null;
  readonly position: number;
  readonly rule: BadgeRule | null;
}

export interface MemberBadgeRecord extends BadgeRecord {
  readonly featured: boolean;
  readonly awardedAt: Date;
}

interface BadgeRow {
  readonly id: string;
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly description_labels: Readonly<Record<string, string>>;
  readonly image_key: string | null;
  readonly position: number;
  readonly rule_type: BadgeRuleType | null;
  readonly rule_threshold: number | null;
  readonly rule_forum_id: string | null;
}

function badgeRecord(row: BadgeRow): BadgeRecord {
  return {
    id: row.id,
    key: row.key,
    labels: row.labels,
    descriptionLabels: row.description_labels,
    imageKey: row.image_key,
    position: row.position,
    rule:
      row.rule_type === null || row.rule_threshold === null
        ? null
        : {
            type: row.rule_type,
            threshold: row.rule_threshold,
            forumId: row.rule_forum_id,
          },
  };
}

const BADGE_SELECT = `
  b.id::text AS id,
  b.key,
  b.labels,
  b.description_labels,
  b.image_key,
  b.position,
  r.type AS rule_type,
  r.threshold AS rule_threshold,
  r.forum_id::text AS rule_forum_id
`;

export async function listBadges(sql: SQL): Promise<readonly BadgeRecord[]> {
  const rows = (await sql.unsafe(`
    SELECT ${BADGE_SELECT}
    FROM core.badges b
    LEFT JOIN core.badge_rules r ON r.badge_id = b.id
    ORDER BY b.position, b.id
  `)) as BadgeRow[];

  return rows.map(badgeRecord);
}

export async function readMemberBadges(
  sql: SQL,
  memberId: string,
): Promise<readonly MemberBadgeRecord[]> {
  const rows = (await sql.unsafe(
    `
    SELECT ${BADGE_SELECT}, mb.featured, mb.created_at
    FROM core.member_badges mb
    JOIN core.badges b ON b.id = mb.badge_id
    LEFT JOIN core.badge_rules r ON r.badge_id = b.id
    WHERE mb.member_id = $1 AND mb.revoked_at IS NULL
    ORDER BY b.position, b.id
  `,
    [memberId],
  )) as Array<BadgeRow & { featured: boolean; created_at: Date }>;

  return rows.map((row) => ({
    ...badgeRecord(row),
    featured: row.featured,
    awardedAt: new Date(row.created_at),
  }));
}

export async function saveBadge(sql: SQL, input: BadgeInput): Promise<string> {
  return runMutation({
    sql,
    mutation: badgeMutation,
    input: { memberIds: [] },
    apply: async (tx) => {
      const labels = input.labels;
      const descriptions = input.descriptionLabels;
      const [row] =
        input.id === null
          ? ((await tx`
              INSERT INTO core.badges (key, labels, description_labels, image_key, position)
              VALUES (${input.key}, ${labels}::jsonb, ${descriptions}::jsonb, ${input.imageKey}, ${input.position})
              RETURNING id::text AS id
            `) as Array<{ id: string }>)
          : ((await tx`
              UPDATE core.badges
              SET key = ${input.key},
                  labels = ${labels}::jsonb,
                  description_labels = ${descriptions}::jsonb,
                  image_key = ${input.imageKey},
                  position = ${input.position}
              WHERE id = ${input.id}
              RETURNING id::text AS id
            `) as Array<{ id: string }>);

      if (row === undefined) {
        throw new Error("Badge disappeared while saving");
      }

      await tx`DELETE FROM core.badge_rules WHERE badge_id = ${row.id}`;

      if (input.rule !== null) {
        await tx`
          INSERT INTO core.badge_rules (badge_id, type, threshold, forum_id)
          VALUES (${row.id}, ${input.rule.type}, ${input.rule.threshold}, ${input.rule.forumId})
        `;
      }

      return row.id;
    },
  });
}

export async function deleteBadge(sql: SQL, id: string): Promise<boolean> {
  return runMutation({
    sql,
    mutation: badgeMutation,
    input: { memberIds: [] },
    apply: async (tx) => {
      const rows = (await tx`DELETE FROM core.badges WHERE id = ${id} RETURNING 1`) as unknown[];
      return rows.length > 0;
    },
  });
}

export async function awardBadge(
  sql: SQL,
  input: {
    readonly memberId: string;
    readonly badgeId: string;
    readonly actorId: string | null;
    readonly reason: string | null;
  },
): Promise<boolean> {
  return runMutation({
    sql,
    mutation: badgeMutation,
    input: { memberIds: [input.memberId] },
    apply: async (tx) => {
      const rows = (await tx`
        INSERT INTO core.member_badges (member_id, badge_id, awarded_by, reason)
        VALUES (${input.memberId}, ${input.badgeId}, ${input.actorId}, ${input.reason})
        ON CONFLICT (member_id, badge_id) DO NOTHING
        RETURNING 1
      `) as unknown[];

      if (rows.length === 0) {
        return false;
      }

      await emit(tx, {
        type: "badge.awarded",
        aggregateId: BigInt(input.memberId),
        aggregateVersion: 1n,
        payloadIds: {
          memberId: BigInt(input.memberId),
          badgeId: BigInt(input.badgeId),
        },
      });

      return true;
    },
  });
}

export async function revokeBadge(
  sql: SQL,
  input: { readonly memberId: string; readonly badgeId: string; readonly reason: string | null },
): Promise<boolean> {
  return runMutation({
    sql,
    mutation: badgeMutation,
    input: { memberIds: [input.memberId] },
    apply: async (tx) => {
      const rows = (await tx`
        UPDATE core.member_badges
        SET revoked_at = now(), featured = false, reason = COALESCE(${input.reason}, reason)
        WHERE member_id = ${input.memberId} AND badge_id = ${input.badgeId} AND revoked_at IS NULL
        RETURNING 1
      `) as unknown[];

      return rows.length > 0;
    },
  });
}

export async function setFeaturedBadges(
  sql: SQL,
  memberId: string,
  badgeIds: readonly string[],
): Promise<void> {
  await runMutation({
    sql,
    mutation: badgeMutation,
    input: { memberIds: [memberId] },
    apply: async (tx) => {
      await tx`UPDATE core.member_badges SET featured = false WHERE member_id = ${memberId}`;

      if (badgeIds.length > 0) {
        await tx`
          UPDATE core.member_badges
          SET featured = true
          WHERE member_id = ${memberId}
            AND revoked_at IS NULL
            AND badge_id = ANY(${`{${badgeIds.join(",")}}`}::bigint[])
        `;
      }

      return undefined;
    },
  });
}

/** A badge's translated label, falling back to English. */
export function badgeLabel(badge: Pick<BadgeRecord, "labels">, locale: Locale): string {
  return badge.labels[locale]?.trim() || badge.labels.en?.trim() || "";
}
