import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { runMutation } from "../mutations/index.ts";
import { rankMutation } from "../mutations/members.ts";

export interface RankRecord {
  readonly id: string;
  readonly minPosts: number;
  readonly titleLabels: Readonly<Record<string, string>>;
  readonly pips: number;
  readonly imageKey: string | null;
}

export interface RankInput {
  readonly id: string | null;
  readonly minPosts: number;
  readonly titleLabels: Readonly<Record<Locale, string>>;
  readonly pips: number;
  readonly imageKey: string | null;
}

interface RankRow {
  readonly id: string;
  readonly min_posts: number;
  readonly title_labels: Readonly<Record<string, string>>;
  readonly pips: number;
  readonly image_key: string | null;
}

function rankRecord(row: RankRow): RankRecord {
  return {
    id: row.id,
    minPosts: row.min_posts,
    titleLabels: row.title_labels,
    pips: row.pips,
    imageKey: row.image_key,
  };
}

export function rankTitle(rank: RankRecord, locale: Locale): string {
  return rank.titleLabels[locale]?.trim() || rank.titleLabels.en?.trim() || "";
}

export async function listRanks(sql: SQL): Promise<readonly RankRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, min_posts, title_labels, pips, image_key
    FROM core.ranks
    ORDER BY min_posts ASC, id
  `) as RankRow[];

  return rows.map(rankRecord);
}

export async function readRankForPosts(sql: SQL, postCount: number): Promise<RankRecord | null> {
  const [row] = (await sql`
    SELECT id::text AS id, min_posts, title_labels, pips, image_key
    FROM core.ranks
    WHERE min_posts <= ${postCount}
    ORDER BY min_posts DESC
    LIMIT 1
  `) as RankRow[];

  return row === undefined ? null : rankRecord(row);
}

export async function saveRank(sql: SQL, input: RankInput): Promise<string> {
  return runMutation({
    sql,
    mutation: rankMutation,
    input: {},
    apply: async (tx) => {
      const labels = input.titleLabels;
      const [row] =
        input.id === null
          ? ((await tx`
              INSERT INTO core.ranks (min_posts, title_labels, pips, image_key)
              VALUES (${input.minPosts}, ${labels}::jsonb, ${input.pips}, ${input.imageKey})
              RETURNING id::text AS id
            `) as Array<{ id: string }>)
          : ((await tx`
              UPDATE core.ranks
              SET min_posts = ${input.minPosts},
                  title_labels = ${labels}::jsonb,
                  pips = ${input.pips},
                  image_key = ${input.imageKey},
                  updated_at = now()
              WHERE id = ${input.id}
              RETURNING id::text AS id
            `) as Array<{ id: string }>);

      if (row === undefined) {
        throw new Error("Rank disappeared while saving");
      }

      return row.id;
    },
  });
}

export async function deleteRank(sql: SQL, id: string): Promise<boolean> {
  return runMutation({
    sql,
    mutation: rankMutation,
    input: {},
    apply: async (tx) => {
      const rows = (await tx`DELETE FROM core.ranks WHERE id = ${id} RETURNING 1`) as unknown[];
      return rows.length > 0;
    },
  });
}
