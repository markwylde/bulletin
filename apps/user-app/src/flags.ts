import { readTagVersion } from "@bulletin/cache";
import {
  createFlagRuntime,
  type FlagDefinition,
  type FlagViewer,
  GUEST_VIEWER,
  parseFlagRules,
} from "@bulletin/flags";
import type { SQL } from "bun";
import type { UserAppSessionContext } from "./session.ts";

/** The durable tag holding flag definitions (ADR 0006, 0010). */
export const FLAGS_TAG = "flags";

/** The evaluated render flags for one viewer, plus the variant hash (ADR 0006, 0010). */
export interface ViewerFlags {
  readonly values: Readonly<Record<string, boolean>>;
  readonly clientFlags: Readonly<Record<string, boolean>>;
  readonly hash: string;
}

interface FlagRow {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly default_value: boolean;
  readonly affects_render: boolean;
  readonly client_visible: boolean;
  readonly rules: unknown;
}

async function loadDefinitions(sql: SQL): Promise<readonly FlagDefinition[]> {
  const rows = (await sql`
    SELECT key, description, owner, default_value, affects_render, client_visible, rules
    FROM core.feature_flags
    ORDER BY key
  `) as FlagRow[];

  return rows.map((row) => ({
    key: row.key,
    description: row.description,
    owner: row.owner,
    defaultValue: row.default_value,
    affectsRender: row.affects_render,
    clientVisible: row.client_visible,
    rules: parseFlagRules(row.rules),
  }));
}

/**
 * Flag evaluation for the user app. There is no LISTEN watcher here yet, so the runtime stays
 * untrusted and reads the definitions from Postgres on every request (fail closed, ADR 0010).
 */
export function createUserFlags(sql: SQL) {
  return createFlagRuntime(
    {
      version: () => readTagVersion(sql, FLAGS_TAG),
      load: () => loadDefinitions(sql),
    },
    { backstopMs: 0 },
  );
}

/** The viewer's group keys; guests are the built-in Guests pseudo-group. */
export async function loadFlagViewer(
  sql: SQL,
  session: UserAppSessionContext | null,
): Promise<FlagViewer> {
  if (session === null) {
    return GUEST_VIEWER;
  }

  const rows = (await sql`
    SELECT g.key
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${session.memberId}
    ORDER BY g.key
  `) as Array<{ key: string }>;

  return { memberId: session.memberId, groups: rows.map((row) => row.key) };
}

/** Evaluates the viewer's render flags and hashes them for the cache variant. */
export async function loadViewerFlags(
  sql: SQL,
  session: UserAppSessionContext | null,
): Promise<ViewerFlags> {
  const runtime = createUserFlags(sql);
  const viewer = await loadFlagViewer(sql, session);

  await runtime.ensureFresh();

  return {
    values: runtime.renderFlags(viewer),
    clientFlags: runtime.clientFlags(viewer),
    hash: runtime.renderFlagsHash(viewer),
  };
}
