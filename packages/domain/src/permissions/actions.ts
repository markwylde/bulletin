/**
 * Forum action and moderator-power bits (ADR 0005). The forum matrix persists action bits in
 * `core.forum_permissions.actions`; the capability snapshot uses the same indexes in its
 * per-forum bitmap. Keep `FORUM_ACTIONS` in this order: the database stores the index.
 */
export const FORUM_ACTIONS = [
  "show",
  "read",
  "start",
  "reply",
  "upload",
  "download",
  "vote",
] as const;

export type ForumAction = (typeof FORUM_ACTIONS)[number];

export const FORUM_ACTION_BITS: Readonly<Record<ForumAction, number>> = Object.fromEntries(
  FORUM_ACTIONS.map((action, index) => [action, index]),
) as Readonly<Record<ForumAction, number>>;

export const MODERATOR_POWERS = [
  "edit",
  "soft_delete",
  "hard_delete",
  "restore",
  "move",
  "merge",
  "split",
  "pin",
  "lock",
  "approve",
  "see_unapproved",
  "see_deleted",
  "view_ips",
  "warn",
  "view_edit_history",
  "use_multimod",
] as const;

export type ModeratorPower = (typeof MODERATOR_POWERS)[number];

/**
 * Moderator powers occupy the bits after the forum actions. The API, the SQL mirror and the
 * capability snapshot all read this map, so adding a power does not renumber an action.
 */
export const MODERATOR_POWER_BITS: Readonly<Record<ModeratorPower, number>> = Object.fromEntries(
  MODERATOR_POWERS.map((power, index) => [power, FORUM_ACTIONS.length + index]),
) as Readonly<Record<ModeratorPower, number>>;

export type CapabilityBit = ForumAction | ModeratorPower | PluginForumAction;

/**
 * Plugin forum actions (ADR 0009). They are appended after every core action and moderator
 * power, so registering one never renumbers a stored bit. The registry is process-local; the
 * lifecycle change populates it from installed manifests at startup.
 */
export interface PluginForumActionDefinition {
  readonly key: `plugin.${string}`;
  readonly labelKey: string;
  /** Stable persisted bit, allocated once at install time (23..30). */
  readonly bit?: number;
}

export type PluginForumAction = `plugin.${string}`;

/**
 * Loads forum actions installed by plugins from the shared registry. Every service that
 * checks or renders the matrix calls this once at startup / before building the matrix.
 */
export async function loadPluginForumActions(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
): Promise<void> {
  const rows = (await sql`
    SELECT plugin_id, key, definition->>'labelKey' AS label_key,
           (definition->>'bit') AS bit
    FROM core.plugin_registry
    WHERE kind = 'forum_action'
    ORDER BY plugin_id, key
  `) as Array<{
    plugin_id: string;
    key: string;
    label_key: string | null;
    bit: string | null;
  }>;

  for (const row of rows) {
    const key = row.key.startsWith("plugin.") ? row.key : `plugin.${row.plugin_id}.${row.key}`;

    registerPluginForumAction({
      key: key as PluginForumAction,
      labelKey: row.label_key ?? `plugin.${row.plugin_id}.forumAction.${row.key}`,
      ...(row.bit === null ? {} : { bit: Number(row.bit) }),
    });
  }
}

const pluginForumActions: PluginForumActionDefinition[] = [];
export const PLUGIN_FORUM_ACTION_BASE = FORUM_ACTIONS.length + MODERATOR_POWERS.length;

const MIN_PLUGIN_BIT = PLUGIN_FORUM_ACTION_BASE;
const MAX_PLUGIN_BIT = 30;

export function registerPluginForumAction(definition: PluginForumActionDefinition): void {
  if (!/^plugin\.[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9_]*$/.test(definition.key)) {
    throw new TypeError(`Invalid plugin forum action: ${definition.key}`);
  }

  const existing = pluginForumActions.find((entry) => entry.key === definition.key);

  if (existing !== undefined) {
    return;
  }

  const used = new Set(pluginForumActions.map((entry) => entry.bit));
  let bit = definition.bit;

  if (bit === undefined) {
    for (let candidate = MIN_PLUGIN_BIT; candidate <= MAX_PLUGIN_BIT; candidate += 1) {
      if (!used.has(candidate)) {
        bit = candidate;
        break;
      }
    }
  }

  if (bit === undefined || bit < MIN_PLUGIN_BIT || bit > MAX_PLUGIN_BIT || used.has(bit)) {
    throw new TypeError(`No stable permission bit is available for ${definition.key}`);
  }

  pluginForumActions.push({ ...definition, bit });
}

export function pluginForumActionDefinitions(): readonly PluginForumActionDefinition[] {
  return [...pluginForumActions];
}

/** Core actions followed by registered plugin actions, in stable bit order. */
export function matrixForumActions(): readonly (ForumAction | PluginForumAction)[] {
  return [...FORUM_ACTIONS, ...pluginForumActions.map((entry) => entry.key)];
}

export function pluginForumActionIndex(action: PluginForumAction): number | undefined {
  return pluginForumActions.find((entry) => entry.key === action)?.bit;
}

export function isModeratorPower(value: string): value is ModeratorPower {
  return (MODERATOR_POWERS as readonly string[]).includes(value);
}

export function isForumAction(value: string): value is ForumAction {
  return (FORUM_ACTIONS as readonly string[]).includes(value);
}

export function isPluginForumAction(value: string): value is PluginForumAction {
  return pluginForumActionIndex(value as PluginForumAction) !== undefined;
}

export function capabilityBitIndex(bit: CapabilityBit): number {
  if (isForumAction(bit)) {
    return FORUM_ACTION_BITS[bit];
  }

  if (isModeratorPower(bit)) {
    return MODERATOR_POWER_BITS[bit];
  }

  const index = pluginForumActionIndex(bit);

  if (index === undefined) {
    throw new TypeError(`Unknown capability bit: ${bit}`);
  }

  return index;
}

export function capabilityBitMask(bit: CapabilityBit): number {
  return 1 << capabilityBitIndex(bit);
}

export function hasCapabilityBit(bits: number, bit: CapabilityBit): boolean {
  return (bits & capabilityBitMask(bit)) !== 0;
}

/** Builds the `core.forum_permissions.actions` bitmap from actions. */
export function forumActionMask(actions: readonly (ForumAction | PluginForumAction)[]): number {
  return actions.reduce((mask, action) => mask | capabilityBitMask(action), 0);
}

/** Decodes a stored action bitmap, in `FORUM_ACTIONS` order. */
export function forumActionsFromMask(bits: number): readonly (ForumAction | PluginForumAction)[] {
  return matrixForumActions().filter((action) => hasCapabilityBit(bits, action));
}

/** The group-setting key that grants a moderator power globally (ADR 0005). */
export function moderatorSettingKey(power: ModeratorPower): `moderation.${ModeratorPower}` {
  return `moderation.${power}`;
}
