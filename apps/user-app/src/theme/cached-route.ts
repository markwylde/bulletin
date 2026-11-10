import {
  type RenderCache,
  type RenderStatus,
  type TagVersionSource,
  variantKey,
} from "@bulletin/cache";
import type { ColorScheme, Locale } from "@bulletin/i18n";
import { type LoadedTheme, themeContentKey } from "@bulletin/templates";
import { etagFor, type ShellVariant, shellKey } from "../http/cache.ts";

/** What one template render produced, before the shared cache sees it. */
export interface PageRender {
  readonly html: string;
  readonly errors: readonly string[];
}

export interface PageVariantInput {
  /** Canonical route pattern, e.g. `/` or `/_demo/[id]`. */
  readonly route: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** ADR 0005 visibility key; a public page with no capability-dependent HTML has one too. */
  readonly visibilityKey: string;
  readonly theme: LoadedTheme | null;
  readonly pluginsGeneration: number;
  readonly locale: Locale;
  readonly colourScheme: ColorScheme;
  readonly renderFlagsHash: string;
}

/** The variant dimensions ADR 0006 puts in a key, without the cache machinery around them. */
export function pageVariant(input: PageVariantInput): string {
  return variantKey({
    route: input.route,
    ...(input.params === undefined ? {} : { params: input.params }),
    visibilityKey: input.visibilityKey,
    themeId: input.theme?.theme.id ?? "0",
    themeVersion: input.theme?.theme.version ?? 0,
    // A template-row or parent-theme edit must invalidate cached HTML and the ETag.
    ...(input.theme === null ? {} : { themeContentKey: themeContentKey(input.theme) }),
    pluginsGeneration: input.pluginsGeneration,
    locale: input.locale,
    colourScheme: input.colourScheme,
    renderFlagsHash: input.renderFlagsHash,
  });
}

/** The key and the view-model data, both produced after the tag snapshot. */
export interface PreparedPage<T> {
  readonly variant: string;
  readonly data: T;
}

export interface CachedPageInput<T> {
  readonly tags: readonly string[];
  /**
   * The fragment cache. Pass `null` for a personal, no-store page: the same prepare-then-render
   * pipeline runs (so data is still loaded after any snapshot) without retaining the HTML.
   */
  readonly cache: RenderCache | null;
  readonly tagVersions: TagVersionSource | null;
  /** Per-response shell dimensions; they change the ETag, never the shared fragment key. */
  readonly shell?: ShellVariant;
  /** Loads the view model and computes the variant; runs after the cache's tag snapshot. */
  readonly prepare: () => Promise<PreparedPage<T>>;
  readonly render: (data: T) => Promise<PageRender>;
}

export interface CachedPageResult {
  readonly cache: RenderStatus | null;
  readonly html: string;
  readonly variant: string;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly errors: readonly string[];
}

/**
 * The shared page pipeline (ADR 0006): the variant key and the view-model data are produced by
 * `prepare` inside `getOrRender`, after the tag versions are captured, and a tag that moves
 * during preparation makes the cache reload rather than store stale HTML under a newer
 * version. The ETag covers the versions that describe the stored fragment plus the per-response
 * shell (guest/member), while guests and members keep sharing one fragment key.
 */
export async function renderCachedPage<T>(input: CachedPageInput<T>): Promise<CachedPageResult> {
  if (input.cache === null) {
    const prepared = await input.prepare();
    const page = await input.render(prepared.data);

    return {
      cache: null,
      html: page.html,
      variant: prepared.variant,
      tags: input.tags,
      etag: null,
      errors: page.errors,
    };
  }

  let errors: readonly string[] = [];
  const rendered = await input.cache.getOrRender({
    tags: input.tags,
    prepare: async () => {
      const prepared = await input.prepare();
      return { key: prepared.variant, data: prepared.data };
    },
    render: async (data) => {
      const page = await input.render(data);
      errors = page.errors;
      return page.html;
    },
  });
  const etag =
    input.tagVersions?.isTrusted() === true
      ? etagFor(rendered.key, rendered.versions, shellKey(input.shell))
      : null;

  return {
    cache: rendered.status,
    html: rendered.html,
    variant: rendered.key,
    tags: rendered.tags,
    etag,
    errors,
  };
}
