import { isValidFlagDefinition } from "./rules.ts";
import type { FlagDefinition } from "./types.ts";

export interface FlagDeclaration {
  readonly key: string;
  readonly description: string;
  /** The team or person responsible for removing the flag once it is stable. */
  readonly owner: string;
  /** Environment default from code, before any staff rule. */
  readonly default: boolean;
  readonly affectsRender?: boolean;
  readonly clientVisible?: boolean;
}

/**
 * Declares a flag in code. `syncFlagDefinitions` upserts missing declarations at startup, so a
 * new flag appears in the staff app with its code default and no rules.
 */
export function defineFlag(declaration: FlagDeclaration): FlagDefinition {
  const definition: FlagDefinition = {
    key: declaration.key,
    description: declaration.description,
    owner: declaration.owner,
    defaultValue: declaration.default,
    affectsRender: declaration.affectsRender ?? false,
    clientVisible: declaration.clientVisible ?? false,
    rules: Object.freeze([]),
  };

  if (!isValidFlagDefinition(definition)) {
    throw new Error(
      `Invalid flag declaration "${declaration.key}": key, description and owner are required`,
    );
  }

  return Object.freeze(definition);
}

/** Validates a registry, rejecting duplicate keys before anything reaches the database. */
export function assertFlagDefinitions(definitions: readonly FlagDefinition[]): void {
  const seen = new Set<string>();

  for (const definition of definitions) {
    if (!isValidFlagDefinition(definition)) {
      throw new Error(`Invalid flag definition "${definition.key}"`);
    }

    if (seen.has(definition.key)) {
      throw new Error(`Duplicate flag definition "${definition.key}"`);
    }

    seen.add(definition.key);
  }
}

/** Global and forum announcements (ADR 0010, change `forum-structure`). */
export const announcementsFlag = defineFlag({
  key: "announcements",
  description: "Global and forum announcements.",
  owner: "core",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Link preview cards fetched by the unfurl worker (ADR 0007). */
export const unfurlsFlag = defineFlag({
  key: "unfurls",
  description: "Link preview cards fetched by workers.",
  owner: "content",
  default: false,
  affectsRender: true,
});

/** @mentions and the editor autocomplete (ADR 0007). */
export const mentionsFlag = defineFlag({
  key: "mentions",
  description: "Member mentions and editor autocomplete.",
  owner: "content",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Every flag declared in code. Each feature adds its own entry here. */
export const CODE_FLAG_DEFINITIONS: readonly FlagDefinition[] = Object.freeze([
  announcementsFlag,
  unfurlsFlag,
  mentionsFlag,
]);
