export type KeyPart = string | number | boolean | null | undefined;

/**
 * Builds a deterministic key from named parts. Parts are sorted so callers never depend on
 * object order, and `undefined` is kept apart from the empty string.
 */
export function stableKey(parts: Readonly<Record<string, KeyPart>>): string {
  return Object.keys(parts)
    .sort()
    .map((name) => {
      const value = parts[name];
      const encoded = value === undefined ? "\u0000undefined" : String(value);
      return `${encodeURIComponent(name)}=${encodeURIComponent(encoded)}`;
    })
    .join("&");
}

export type ColourScheme = "light" | "dark" | "system";

/**
 * The variant dimensions from ADR 0006. The key answers "what can this viewer see", never
 * "who is this viewer": no member id or session id is part of it.
 */
export interface CacheVariantInput {
  /** Canonical route pattern, e.g. `/_demo/[id]`. */
  readonly route: string;
  /** Route parameters that change the rendered resource, e.g. `{ id: "12" }`. */
  readonly params?: Readonly<Record<string, string | number>>;
  /** ADR 0005 visibility key: the declared capability answers plus unlock state. */
  readonly visibilityKey: string;
  readonly themeId: string | number;
  readonly themeVersion: number;
  /** ADR 0009 plugin generation. */
  readonly pluginsGeneration: number;
  readonly locale: string;
  readonly colourScheme: ColourScheme;
  /** Hash of the evaluated values of `affectsRender` flags (ADR 0010). */
  readonly renderFlagsHash: string;
}

function nonEmpty(name: string, value: string): void {
  if (value.trim() === "") {
    throw new Error(`Cache variant ${name} must not be empty`);
  }
}

/** Builds the variant key for one rendered page (ADR 0006). */
export function variantKey(input: CacheVariantInput): string {
  nonEmpty("route", input.route);
  nonEmpty("visibilityKey", input.visibilityKey);

  return stableKey({
    route: input.route,
    params: stableKey(input.params ?? {}),
    visibility: input.visibilityKey,
    theme: `${input.themeId}@${input.themeVersion}`,
    plugins: input.pluginsGeneration,
    locale: input.locale,
    scheme: input.colourScheme,
    flags: input.renderFlagsHash,
  });
}
