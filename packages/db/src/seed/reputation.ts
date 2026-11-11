import { rebuildReactionEntries, recomputeAllReputations } from "@bulletin/domain/reputation";
import type { SeedModule } from "./framework.ts";

/** Enough posts to make every forum's first pages show reaction and reputation activity. */
const SEEDED_POST_LIMIT = 220;

interface MemberRow {
  readonly id: string;
}

interface PostRow {
  readonly id: string;
  readonly author_id: string;
}

interface ReactionRow {
  readonly id: string;
  readonly key: string;
  readonly weight: number;
}

function otherMember(
  members: readonly MemberRow[],
  authorId: string,
  offset: number,
): string | null {
  for (let step = 0; step < members.length; step += 1) {
    const member = members[(offset + step) % members.length];

    if (member !== undefined && member.id !== authorId) {
      return member.id;
    }
  }

  return null;
}

/**
 * Seed reactions and reputation across the first posts (the hand-written topics come first,
 * then the bulk set). Reaction entries are derived from the seeded reactions through the same
 * domain path the recount job uses, then every member total is recomputed from the entries, so
 * the seeded board is consistent from the first page load (task 4.2).
 */
export const reputationSeedModule: SeedModule = {
  name: "reputation",
  dependsOn: ["base", "reactions", "members", "topics"],
  async run({ sql }) {
    await sql`
      UPDATE core.board_settings
      SET reactions_affect_reputation = true
      WHERE id = 1
    `;

    const members = (await sql`
      SELECT id::text AS id
      FROM core.members
      WHERE is_service = false AND state = 'active'
      ORDER BY id
    `) as MemberRow[];
    const posts = (await sql`
      SELECT p.id::text AS id, p.author_id::text AS author_id
      FROM core.posts p
      JOIN core.topics t ON t.id = p.topic_id
      WHERE p.visibility = 'visible' AND p.author_id IS NOT NULL
      ORDER BY p.id
      LIMIT ${SEEDED_POST_LIMIT}
    `) as PostRow[];
    const reactions = (await sql`
      SELECT id::text AS id, key, weight
      FROM core.reactions
      WHERE enabled
      ORDER BY position, id
    `) as ReactionRow[];

    if (members.length === 0 || posts.length === 0 || reactions.length === 0) {
      return;
    }

    // Mostly positive reactions, with a negative one every ninth post so the label scale shows.
    const positive = reactions.filter((reaction) => reaction.weight > 0 && reaction.key !== "wow");
    const negative = reactions.filter((reaction) => reaction.weight < 0);
    const pool = positive.length === 0 ? reactions : positive;

    for (const [index, post] of posts.entries()) {
      const count = 1 + (index % 2);
      const useNegative = negative.length > 0 && index % 9 === 0;
      const choices = useNegative ? negative : pool;

      for (let slot = 0; slot < count; slot += 1) {
        const giver = otherMember(members, post.author_id, index * 3 + slot + 1);
        const reaction = choices[(index + slot) % choices.length];

        if (giver === null || reaction === undefined) {
          continue;
        }

        await sql`
          INSERT INTO core.post_reactions (post_id, member_id, reaction_id)
          VALUES (${post.id}, ${giver}, ${reaction.id})
          ON CONFLICT (post_id, member_id) DO NOTHING
        `;
      }

      // Every third post also carries an explicit reputation vote, so both sources are seeded.
      if (index % 3 === 0) {
        const voter = otherMember(members, post.author_id, index * 5 + 2);

        if (voter !== null) {
          await sql`
            INSERT INTO core.reputation_entries (
              post_id, giver_id, receiver_id, points, source
            )
            VALUES (${post.id}, ${voter}, ${post.author_id}, 1, 'vote')
            ON CONFLICT (post_id, giver_id, source) DO NOTHING
          `;
        }
      }
    }

    // Reaction weights are part of the seed; derive their entries, then sum every total.
    await rebuildReactionEntries(sql);
    await recomputeAllReputations(sql);

    await sql`
      UPDATE core.posts p
      SET reaction_summary = COALESCE(
        (
          SELECT jsonb_object_agg(tally.reaction_id::text, tally.total)
          FROM (
            SELECT reaction_id, count(*)::int AS total
            FROM core.post_reactions
            WHERE post_id = p.id
            GROUP BY reaction_id
          ) tally
        ),
        '{}'::jsonb
      )
      WHERE EXISTS (SELECT 1 FROM core.post_reactions WHERE post_id = p.id)
    `;
  },
};
