import { CACHE_TAG_NOTIFY_CHANNEL } from "@bulletin/cache";
import type { SQL } from "bun";

export const PERM_TAG = "perm";

interface VersionRow {
  readonly version: string;
}

/** Reads the durable `perm` tag version; a missing row means no permission writes yet. */
export async function readPermVersion(sql: SQL): Promise<string> {
  const [row] = (await sql`
    SELECT version
    FROM core.cache_tags
    WHERE tag = ${PERM_TAG}
  `) as VersionRow[];

  return row?.version ?? "0";
}

/**
 * Bumps the `perm` tag in the caller's transaction and wakes listeners after commit (ADR 0006).
 * Permission, mask, group and membership mutations call this; the in-process snapshot cache
 * also checks the tag once per second as a NOTIFY-independent backstop.
 */
export async function bumpPermVersion(sql: SQL): Promise<string> {
  const [row] = (await sql`
    INSERT INTO core.cache_tags (tag, version, updated_at)
    VALUES (${PERM_TAG}, 1, now())
    ON CONFLICT (tag) DO UPDATE
      SET version = core.cache_tags.version + 1, updated_at = now()
    RETURNING version
  `) as VersionRow[];

  if (row === undefined) {
    throw new Error("Could not bump the perm tag");
  }

  await sql`SELECT pg_notify(${CACHE_TAG_NOTIFY_CHANNEL}, ${`${PERM_TAG}:${row.version}`})`;

  return row.version;
}
