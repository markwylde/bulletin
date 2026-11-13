import type { RenderCache, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { homeContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import { type BoardIndexData, buildBoardIndex } from "../forums/index.ts";
import type { ShellVariant } from "../http/cache.ts";
import { enrichView } from "../plugins/enrich.ts";
import type { UserAppSessionContext } from "../session.ts";
import { type CachedPageResult, pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";

export interface HomeRouteInput {
  readonly sql: SQL;
  /** The preview or guest-chosen theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
  /** Preview responses are private and never stored in the shared fragment cache. */
  readonly preview?: boolean | undefined;
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
  readonly flags: ViewerFlags;
}

/** The board index at `/` through the shared variant/cache/ETag pipeline (ADR 0006). */
export async function renderHomeRoute(input: HomeRouteInput): Promise<HomeRouteResult> {
  let title = "";
  const enrichment = await enrichView({
    hook: "home.view",
    route: "home",
    view: { route: "home" },
    viewer: { memberId: input.session?.memberId ?? null },
  });

  const rendered = await renderCachedPage<HomeData>({
    tags: [...contractTags(homeContract, {}), ...enrichment.tags],
    contentValidator: true,
    cache: input.preview === true ? null : input.cache,
    tagVersions: input.tagVersions ?? null,
    ...(input.shell === undefined ? {} : { shell: input.shell }),
    // The view model is loaded after the cache captured its tag versions. A tree or settings
    // save that lands during it bumps `board`, and the pipeline renders again.
    prepare: async () => {
      const [theme, settings, flags] = await Promise.all([
        loadActiveTheme(input.sql, input.themeId),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session ?? null),
      ]);
      const index = await buildBoardIndex({
        sql: input.sql,
        locale: input.locale,
        translate: input.translate,
        session: input.session ?? null,
        announcementsEnabled: flags.values.announcements === true,
        mentionsEnabled: flags.values.mentions === true,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
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
          renderFlagsHash: flags.hash,
        }),
        data: { theme, boardName, boardDescription, index, flags },
        ...(index.ttlMs === null ? {} : { ttlMs: index.ttlMs }),
      };
    },
    render: async ({ theme, boardName, boardDescription, index, flags }) => {
      const page = await renderThemedPage({
        sql: input.sql,
        themeId: input.themeId,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: homeContract.templates.page,
        viewModel: {
          boardName,
          boardDescription,
          ...index.viewModel,
          ...enrichment.fields,
          flags: { ...index.viewModel.flags, ...flags.values },
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
