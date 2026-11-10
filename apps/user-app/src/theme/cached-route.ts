import {
  type RenderCache,
  type RenderStatus,
  type TagVersionSource,
  variantKey,
} from "@bulletin/cache";
import type { ColorScheme, Locale } from "@bulletin/i18n";
import { type LoadedTheme, themeContentKey } from "@bulletin/templates";
import { etagFor } from "../http/cache.ts";

/** What one template render produced, before the shared cache sees it. */
export interface PageRender {
  readonly html: string;
  readonly errors: readonly string[];
}

export interface CachedPageInput {
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
  readonly tags: readonly string[];
  readonly cache: RenderCache;
  readonly tagVersions: TagVersionSource | null;
  readonly render: () => Promise<PageRender>;
}

export interface CachedPageResult {
  readonly cache: RenderStatus;
  readonly html: string;
  readonly variant: string;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly errors: readonly string[];
}

/** The variant dimensions ADR 0006 puts in a key, without the cache machinery around them. */
export function pageVariant(
  input: Omit<CachedPageInput, "tags" | "cache" | "tagVersions" | "render">,
): string {
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

/**
 * The shared page pipeline (ADR 0006): variant key, tagged fragment cache, and an ETag built
 * from the versions captured before the render, so an invalidation that races a render can
 * never pair old HTML with a newer ETag.
 */
export async function renderCachedPage(input: CachedPageInput): Promise<CachedPageResult> {
  const variant = pageVariant(input);
  let errors: readonly string[] = [];
  const rendered = await input.cache.getOrRender({
    key: variant,
    tags: input.tags,
    render: async () => {
      const page = await input.render();
      errors = page.errors;
      return page.html;
    },
  });
  const source = input.tagVersions;
  const etag = source?.isTrusted() === true ? etagFor(variant, rendered.versions) : null;

  return {
    cache: rendered.status,
    html: rendered.html,
    variant,
    tags: rendered.tags,
    etag,
    errors,
  };
}
