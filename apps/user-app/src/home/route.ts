import type { RenderCache, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { homeContract } from "../contracts.ts";
import { type BoardIndexData, buildBoardIndex } from "../forums/index.ts";
import type { ShellVariant } from "../http/cache.ts";
import type { UserAppSessionContext } from "../session.ts";
import { type CachedPageResult, pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";

export interface HomeRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session?: UserAppSessionContext | null;
  /** Test seam for announcement transitions. */
  readonly now?: Date;
  /** Benchmark-only variant input: a unique value forces a cold render (task 7.1). */
  readonly bench?: number;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
  /** Guest and member shells differ (`data-visitor`, overlay), so their ETags must too. */
  readonly shell?: ShellVariant;
}

export interface HomeRouteResult extends CachedPageResult {
  readonly title: string;
  readonly hasUnlockGrant: boolean;
}

interface HomeData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly boardDescription: string;
  readonly index: BoardIndexData;
}

/** The board index at `/` through the shared variant/cache/ETag pipeline (ADR 0006). */
export async function renderHomeRoute(input: HomeRouteInput): Promise<HomeRouteResult> {
  let title = "";

  const rendered = await renderCachedPage<HomeData>({
    tags: contractTags(homeContract, {}),
    cache: input.cache,
    tagVersions: input.tagVersions ?? null,
    ...(input.shell === undefined ? {} : { shell: input.shell }),
    // The view model is loaded after the cache captured its tag versions. A tree or settings
    // save that lands during it bumps `board`, and the pipeline renders again.
    prepare: async () => {
      const [theme, settings, index] = await Promise.all([
        loadActiveTheme(input.sql),
        readBoardSettings(input.sql),
        buildBoardIndex({
          sql: input.sql,
          locale: input.locale,
          translate: input.translate,
          session: input.session ?? null,
          ...(input.now === undefined ? {} : { now: input.now }),
        }),
      ]);
      const boardName = boardNameFrom(settings.boardName, input.translate);
      const boardDescription =
        settings.boardDescription.trim() || input.translate("user.placeholder.body");

      title = boardName;

      return {
        variant: pageVariant({
          route: homeContract.route,
          params: {
            ...(input.bench === undefined || input.bench === 0 ? {} : { bench: input.bench }),
          },
          visibilityKey: index.visibilityKey,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: "",
        }),
        data: { theme, boardName, boardDescription, index },
        ...(index.ttlMs === null ? {} : { ttlMs: index.ttlMs }),
      };
    },
    render: async ({ theme, boardName, boardDescription, index }) => {
      const page = await renderThemedPage({
        sql: input.sql,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: homeContract.templates.page,
        viewModel: {
          boardName,
          boardDescription,
          categories: index.viewModel.categories,
          announcements: index.viewModel.announcements,
        },
        breadcrumbs: [],
        route: homeContract,
        pluginsGeneration: input.pluginsGeneration,
        theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  return {
    ...rendered,
    title,
    hasUnlockGrant: false,
  };
}
