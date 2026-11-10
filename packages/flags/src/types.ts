/** A rule that turns a flag on or off for members of any of the listed groups. */
export interface GroupFlagRule {
  readonly type: "group";
  /** Group keys, for example `moderators`; `guests` is the guest pseudo-group. */
  readonly groups: readonly string[];
  readonly value: boolean;
}

/** A rule that turns a flag on or off for a stable percentage of members. */
export interface PercentageFlagRule {
  readonly type: "percentage";
  /** Whole percent from 0 to 100. */
  readonly percent: number;
  readonly value: boolean;
}

export type FlagRule = GroupFlagRule | PercentageFlagRule;

/** One flag as declared in code or stored in `core.feature_flags`. */
export interface FlagDefinition {
  readonly key: string;
  readonly description: string;
  readonly owner: string;
  readonly defaultValue: boolean;
  /** Flags that change rendered output are part of the cache variant (ADR 0006). */
  readonly affectsRender: boolean;
  /** Only these flags may be sent to the browser. */
  readonly clientVisible: boolean;
  readonly rules: readonly FlagRule[];
}

/** The request-scoped facts evaluation needs; authorisation itself stays in `can()`. */
export interface FlagViewer {
  readonly memberId: string | null;
  /** Every group key the viewer belongs to. Guests only have `guests`. */
  readonly groups: readonly string[];
}

export const GUEST_GROUP = "guests";

export const GUEST_VIEWER: FlagViewer = {
  memberId: null,
  groups: [GUEST_GROUP],
};

const FLAG_KEY = /^[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)*$/;

export function isFlagKey(value: string): boolean {
  return FLAG_KEY.test(value);
}
