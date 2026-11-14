import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { buildSeoMetadata, type SeoMetadata } from "@bulletin/domain/seo";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { leaderboardContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { buildLeaderboardsPage, type LeaderboardView } from "./page.ts";

export interface LeaderboardRouteInput {
  readonly sql: SQL;
  /** The preview or guest-chosen theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
  /** Preview responses are private and never stored in the shared fragment cache. */
  readonly preview?: boolean | undefined;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

interface LeaderboardData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly page: LeaderboardView;
  readonly flags: ViewerFlags;
  readonly seo: SeoMetadata;
}

export async function renderLeaderboardRoute(input: LeaderboardRouteInput): Promise<{
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly cache: RenderStatus | null;
  readonly variant: string;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly status: number;
  readonly seo: SeoMetadata;
  readonly errors: readonly string[];
}> {
  const viewerFlags = await loadViewerFlags(input.sql, input.session);

  if (viewerFlags.values.leaderboards !== true) {
    const notFound = await renderThemedNotFound({
      sql: input.sql,
      themeId: input.themeId,
      locale: input.locale,
      translate: input.translate,
      route: leaderboardContract,
    });

    return {
      ...notFound,
      cache: null,
      variant: "flag-off",
      tags: [],
      etag: null,
      status: 404,
      seo: buildSeoMetadata({
        title: input.translate("leaderboards.title"),
        boardName: "",
        description: input.translate("seo.leaderboards.description"),
        canonicalPath: "/leaderboards",
        robots: "noindex",
      }),
    };
  }

  let title = input.translate("leaderboards.title");
  let boardName = "";
  let latestSeo: SeoMetadata | null = null;

  const rendered = await renderCachedPage<LeaderboardData>({
    tags: contractTags(leaderboardContract, {}),
    cache: input.preview === true ? null : input.cache,
    tagVersions: input.tagVersions ?? null,
    shell: { visitor: input.session === null ? "guest" : "member" },
    prepare: async () => {
      const [theme, settings, flags, page] = await Promise.all([
        loadActiveTheme(input.sql, input.themeId),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
        buildLeaderboardsPage({
          sql: input.sql,
          locale: input.locale,
          translate: input.translate,
        }),
      ]);
      const name = boardNameFrom(settings.boardName, input.translate);
      title = page.title;
      boardName = name;
      latestSeo = buildSeoMetadata({
        title: page.title,
        boardName: name,
        description: input.translate("seo.leaderboards.description"),
        canonicalPath: "/leaderboards",
      });

      return {
        variant: pageVariant({
          route: leaderboardContract.route,
          visibilityKey: page.visibilityKey,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: flags.hash,
        }),
        data: { theme, boardName: name, page, flags, seo: latestSeo },
      };
    },
    render: async (data) => {
      const page = await renderThemedPage({
        sql: input.sql,
        themeId: input.themeId,
        boardName: data.boardName,
        locale: input.locale,
        translate: input.translate,
        template: leaderboardContract.templates.page,
        viewModel: { ...data.page, seo: data.seo, flags: data.flags.values },
        breadcrumbs: [{ label: input.translate("leaderboards.title"), href: null }],
        route: leaderboardContract,
        pluginsGeneration: input.pluginsGeneration,
        theme: data.theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  return {
    ...rendered,
    title,
    boardName,
    status: 200,
    seo:
      latestSeo ??
      buildSeoMetadata({
        title,
        boardName,
        description: input.translate("seo.leaderboards.description"),
        canonicalPath: "/leaderboards",
      }),
  };
}
