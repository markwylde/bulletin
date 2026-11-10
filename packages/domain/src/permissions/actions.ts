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

export type CapabilityBit = ForumAction | ModeratorPower;

export function isModeratorPower(value: string): value is ModeratorPower {
  return (MODERATOR_POWERS as readonly string[]).includes(value);
}

export function isForumAction(value: string): value is ForumAction {
  return (FORUM_ACTIONS as readonly string[]).includes(value);
}

export function capabilityBitIndex(bit: CapabilityBit): number {
  return isForumAction(bit) ? FORUM_ACTION_BITS[bit] : MODERATOR_POWER_BITS[bit];
}

export function capabilityBitMask(bit: CapabilityBit): number {
  return 1 << capabilityBitIndex(bit);
}

export function hasCapabilityBit(bits: number, bit: CapabilityBit): boolean {
  return (bits & capabilityBitMask(bit)) !== 0;
}

/** Builds the `core.forum_permissions.actions` bitmap from actions. */
export function forumActionMask(actions: readonly ForumAction[]): number {
  return actions.reduce((mask, action) => mask | capabilityBitMask(action), 0);
}

/** Decodes a stored action bitmap, in `FORUM_ACTIONS` order. */
export function forumActionsFromMask(bits: number): readonly ForumAction[] {
  return FORUM_ACTIONS.filter((action) => hasCapabilityBit(bits, action));
}

/** The group-setting key that grants a moderator power globally (ADR 0005). */
export function moderatorSettingKey(power: ModeratorPower): `moderation.${ModeratorPower}` {
  return `moderation.${power}`;
}
