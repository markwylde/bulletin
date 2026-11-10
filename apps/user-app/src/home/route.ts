import type { RenderCache, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { homeContract } from "../contracts.ts";
import type { ShellVariant } from "../http/cache.ts";
import { type CachedPageResult, pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";

export interface HomeRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
  /** Guest and member shells differ (`data-visitor`, overlay), so their ETags must too. */
  readonly shell?: ShellVariant;
}

export interface HomeRouteResult extends CachedPageResult {
  readonly title: string;
}

/**
 * The board shell's visibility key. Home reads no capability bits: member-only UI is hidden in
 * the shared HTML and revealed by the per-request overlay, so every viewer shares a variant.
 */
export const HOME_VISIBILITY_KEY = "public";

interface HomeData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly boardDescription: string;
}

/** The home page through the shared variant/cache/ETag pipeline (ADR 0006). */
export async function renderHomeRoute(input: HomeRouteInput): Promise<HomeRouteResult> {
  let title = "";

  const rendered = await renderCachedPage<HomeData>({
    tags: contractTags(homeContract, {}),
    cache: input.cache,
    tagVersions: input.tagVersions ?? null,
    ...(input.shell === undefined ? {} : { shell: input.shell }),
    // Board settings are read here, after the cache captured its tag versions. A save that
    // lands during this render bumps `board`, and the pipeline renders again instead of
    // storing the old name under the new version.
    prepare: async () => {
      const [theme, settings] = await Promise.all([
        loadActiveTheme(input.sql),
        readBoardSettings(input.sql),
      ]);
      const boardName = boardNameFrom(settings.boardName, input.translate);
      const boardDescription =
        settings.boardDescription.trim() || input.translate("user.placeholder.body");

      title = boardName;

      return {
        variant: pageVariant({
          route: homeContract.route,
          visibilityKey: HOME_VISIBILITY_KEY,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: "",
        }),
        data: { theme, boardName, boardDescription },
      };
    },
    render: async ({ theme, boardName, boardDescription }) => {
      const page = await renderThemedPage({
        sql: input.sql,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: homeContract.templates.page,
        viewModel: { boardName, boardDescription },
        breadcrumbs: [],
        route: homeContract,
        pluginsGeneration: input.pluginsGeneration,
        theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  return { ...rendered, title };
}
