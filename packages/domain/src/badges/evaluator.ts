import type { SQL } from "bun";
import { awardBadge, type BadgeRule, listBadges } from "./repository.ts";

interface MemberFacts {
  readonly post_count: number;
  readonly reputation: number;
  readonly joined_at: Date;
}

export async function evaluateBadgeRulesForMember(
  sql: SQL,
  memberId: string,
  now: Date = new Date(),
): Promise<number> {
  const badges = (await listBadges(sql)).filter(
    (badge): badge is typeof badge & { readonly rule: BadgeRule } => badge.rule !== null,
  );

  if (badges.length === 0) {
    return 0;
  }

  const [member] = (await sql`
    SELECT post_count, reputation, joined_at
    FROM core.members
    WHERE id = ${memberId} AND state = 'active' AND is_service = false
  `) as MemberFacts[];

  if (member === undefined) {
    return 0;
  }

  let awarded = 0;

  for (const badge of badges) {
    const rule = badge.rule;
    let value: number;

    switch (rule.type) {
      case "post_count":
        value = member.post_count;
        break;
      case "reputation":
        value = member.reputation;
        break;
      case "days_joined":
        value = Math.floor((now.getTime() - new Date(member.joined_at).getTime()) / 86_400_000);
        break;
      case "reactions_received": {
        const [row] = (await sql`
          SELECT count(*)::int AS count
          FROM core.post_reactions pr
          JOIN core.posts p ON p.id = pr.post_id
          WHERE p.author_id = ${memberId} AND p.visibility = 'visible'
        `) as Array<{ count: number }>;
        value = row?.count ?? 0;
        break;
      }
      case "topics_started": {
        const [row] = (await sql`
          SELECT count(*)::int AS count
          FROM core.topics
          WHERE starter_id = ${memberId} AND moved_to IS NULL
        `) as Array<{ count: number }>;
        value = row?.count ?? 0;
        break;
      }
      case "posts_in_forum": {
        if (rule.forumId === null) {
          value = 0;
          break;
        }

        const [row] = (await sql`
          SELECT count(*)::int AS count
          FROM core.posts p
          JOIN core.topics t ON t.id = p.topic_id
          WHERE p.author_id = ${memberId}
            AND t.forum_id = ${rule.forumId}
            AND p.visibility = 'visible'
        `) as Array<{ count: number }>;
        value = row?.count ?? 0;
        break;
      }
    }

    if (value >= rule.threshold) {
      if (
        await awardBadge(sql, {
          memberId,
          badgeId: badge.id,
          actorId: null,
          reason: "automatic",
        })
      ) {
        awarded += 1;
      }
    }
  }

  return awarded;
}

/** The nightly sweep: evaluate every automatic badge for every active member. */
export async function evaluateAllBadgeRules(sql: SQL, now: Date = new Date()): Promise<number> {
  const rows = (await sql`
    SELECT id::text AS id
    FROM core.members
    WHERE state = 'active' AND is_service = false AND display_name IS NOT NULL
    ORDER BY id
  `) as Array<{ id: string }>;
  let awarded = 0;

  for (const row of rows) {
    awarded += await evaluateBadgeRulesForMember(sql, row.id, now);
  }

  return awarded;
}

/** The member an event can affect, or null when the event is unrelated to badge rules. */
export async function evaluateBadgeRulesForEvent(
  sql: SQL,
  event: { readonly type: string; readonly payloadIds: Readonly<Record<string, string>> },
  now: Date = new Date(),
): Promise<number> {
  let memberId: string | null = null;

  switch (event.type) {
    case "post.approved":
    case "post.created":
      memberId = event.payloadIds.authorId ?? null;
      break;
    case "topic.created":
      memberId = event.payloadIds.authorId ?? null;
      break;
    case "reputation.given":
      memberId = event.payloadIds.receiverId ?? null;
      break;
    case "reaction.added": {
      const postId = event.payloadIds.postId;

      if (postId !== undefined) {
        const [post] = (await sql`
          SELECT author_id::text AS author_id FROM core.posts WHERE id = ${postId}
        `) as Array<{ author_id: string | null }>;
        memberId = post?.author_id ?? null;
      }
      break;
    }
  }

  return memberId === null ? 0 : evaluateBadgeRulesForMember(sql, memberId, now);
}
