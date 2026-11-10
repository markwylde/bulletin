import { bumpCacheTags } from "@bulletin/cache";
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
  const versions = await bumpCacheTags(sql, [PERM_TAG]);
  const version = versions.get(PERM_TAG);

  if (version === undefined) {
    throw new Error("Could not bump the perm tag");
  }

  return version;
}
