import type { RenderCache, TagVersionSource } from "@bulletin/cache";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { homeContract } from "../contracts.ts";
import { type CachedPageResult, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedPage } from "../theme/render.ts";

export interface HomeRouteInput {
  readonly sql: SQL;
  readonly boardName: string;
  readonly boardDescription: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly theme: LoadedTheme | null;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

export interface HomeRouteResult extends CachedPageResult {
  readonly title: string;
}

/**
 * The board shell's visibility key. Home reads no capability bits: member-only UI is hidden in
 * the shared HTML and revealed by the per-request overlay, so every viewer shares a variant.
 */
export const HOME_VISIBILITY_KEY = "public";

/** The home page through the same variant/cache/ETag pipeline as every other user-app page. */
export async function renderHomeRoute(input: HomeRouteInput): Promise<HomeRouteResult> {
  const rendered = await renderCachedPage({
    route: homeContract.route,
    visibilityKey: HOME_VISIBILITY_KEY,
    theme: input.theme,
    pluginsGeneration: input.pluginsGeneration,
    locale: input.locale,
    colourScheme: input.colourScheme,
    renderFlagsHash: "",
    tags: contractTags(homeContract, {}),
    cache: input.cache,
    tagVersions: input.tagVersions ?? null,
    render: async () => {
      const page = await renderThemedPage({
        sql: input.sql,
        boardName: input.boardName,
        locale: input.locale,
        translate: input.translate,
        template: homeContract.templates.page,
        viewModel: { boardName: input.boardName, boardDescription: input.boardDescription },
        breadcrumbs: [],
        route: homeContract,
        pluginsGeneration: input.pluginsGeneration,
        theme: input.theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  return { ...rendered, title: input.boardName };
}
