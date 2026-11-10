/**
 * The canonical hook registry (ADR 0008). Themes place hooks from this list only, and CI
 * fails when the default theme misses a registered point or uses an unregistered one.
 */

export interface HookPoint {
  readonly name: string;
  readonly description: string;
}

export const HOOK_POINTS: readonly HookPoint[] = [
  {
    name: "spike.after.counter",
    description: "After the spike island on the development rendering route.",
  },
];

export const HOOK_NAMES: readonly string[] = HOOK_POINTS.map((point) => point.name);

const DECLARED_HOOK = /\{%-?\s*hook\s+["']([^"']+)["']/g;

/** Hook names a template places via `{% hook "name" %}`. */
export function declaredHooks(source: string): readonly string[] {
  const hooks: string[] = [];

  for (const match of source.matchAll(DECLARED_HOOK)) {
    const name = match[1];

    if (name !== undefined && !hooks.includes(name)) {
      hooks.push(name);
    }
  }

  return hooks;
}

export interface HookAudit {
  /** Registered hooks that no template contains: the default theme is incomplete. */
  readonly missingRegistered: readonly string[];
  /** Hooks a template contains that are not registered: a typo or an unapproved hook. */
  readonly unregistered: readonly string[];
}

/**
 * Audits a theme against the registry. CI runs it for the default theme; plugin installation
 * runs it for a theme that adds hooks.
 */
export function auditHooks(
  templates: Readonly<Record<string, string>>,
  registered: readonly string[] = HOOK_NAMES,
): HookAudit {
  const declared = new Set<string>();

  for (const source of Object.values(templates)) {
    for (const hook of declaredHooks(source)) {
      declared.add(hook);
    }
  }

  const known = new Set(registered);

  return {
    missingRegistered: registered.filter((hook) => !declared.has(hook)),
    unregistered: [...declared].filter((hook) => !known.has(hook)),
  };
}
