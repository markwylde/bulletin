import type { RenderCache, RenderStatus } from "@bulletin/cache";

/** One rendered result the harness inspects; `cache` is present when the route cached it. */
export interface VariantRender {
  readonly variant: string;
  readonly html: string;
  readonly cache?: RenderStatus;
}

export interface VariantCase {
  readonly name: string;
  /** Runs before this case renders; used for permission, unlock and flag changes. */
  readonly setup?: () => Promise<void>;
  /** Runs after the case renders, so a later case starts from a clean database. */
  readonly teardown?: () => Promise<void>;
  readonly render: () => Promise<VariantRender>;
}

/** Content that must never reach a less privileged case (ADR 0006: no leaked content). */
export interface VariantLeak {
  readonly description?: string;
  /** Text unique to the more privileged variant, e.g. a moderator control. */
  readonly markers: readonly string[];
  /** Case names whose HTML must not contain any marker. */
  readonly absentFrom: readonly string[];
}

export interface VariantHarnessOptions {
  readonly route: string;
  readonly cases: readonly VariantCase[];
  /** When set, every case's second render must be served from this cache as a hit. */
  readonly cache?: RenderCache;
  readonly leaks?: readonly VariantLeak[];
}

export interface VariantReport {
  /** Case name to variant key. */
  readonly variants: ReadonlyMap<string, string>;
}

export class CacheVariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheVariantError";
  }
}

/**
 * The reusable cache-variant harness (ADR 0006, task 5.4). Each case renders twice: variants
 * must be distinct, the second render must be a cache hit, and no case may contain another
 * case's exclusive content. Later changes register their routes through it.
 */
export async function assertCacheVariants(options: VariantHarnessOptions): Promise<VariantReport> {
  if (options.cases.length === 0) {
    throw new CacheVariantError(`Route ${options.route} has no variant cases`);
  }

  const rendered: Array<{ readonly case: VariantCase; readonly first: VariantRender }> = [];

  for (const variantCase of options.cases) {
    await variantCase.setup?.();

    try {
      const first = await variantCase.render();
      const second = await variantCase.render();

      if (first.html !== second.html) {
        throw new CacheVariantError(
          `Route ${options.route}, ${variantCase.name}: the repeated render changed the HTML`,
        );
      }

      if (options.cache !== undefined && second.cache !== "hit") {
        throw new CacheVariantError(
          `Route ${options.route}, ${variantCase.name}: the second render was ${second.cache ?? "uncached"}, expected a hit`,
        );
      }

      rendered.push({ case: variantCase, first });
    } finally {
      await variantCase.teardown?.();
    }
  }

  const variants = new Map(rendered.map((entry) => [entry.case.name, entry.first.variant]));
  const unique = new Set(variants.values());

  if (unique.size !== variants.size) {
    const seen = new Set<string>();
    const duplicates = [...variants.entries()]
      .filter(([, variant]) => {
        if (seen.has(variant)) {
          return true;
        }

        seen.add(variant);
        return false;
      })
      .map(([name, variant]) => `${name} (${variant})`);

    throw new CacheVariantError(
      `Route ${options.route}: cases share a variant key: ${duplicates.join(", ")}`,
    );
  }

  const byName = new Map(rendered.map((entry) => [entry.case.name, entry.first.html]));

  for (const leak of options.leaks ?? []) {
    for (const name of leak.absentFrom) {
      const html = byName.get(name);

      if (html === undefined) {
        throw new CacheVariantError(
          `Route ${options.route}: leak "${leak.description ?? leak.markers.join(", ")}" names unknown case "${name}"`,
        );
      }

      for (const marker of leak.markers) {
        if (html.includes(marker)) {
          throw new CacheVariantError(`Route ${options.route}: "${marker}" leaked into ${name}`);
        }
      }
    }
  }

  return { variants };
}
