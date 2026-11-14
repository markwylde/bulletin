import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { can, GUEST_PRINCIPAL } from "@bulletin/domain/permissions";
import { buildSeoMetadata, type SeoMetadata } from "@bulletin/domain/seo";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { memberListContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { buildMemberListPage, type MemberListView } from "./list.ts";

export interface MemberListRouteInput {
  readonly sql: SQL;
  /** The preview or guest-chosen theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
  /** Preview responses are private and never stored in the shared fragment cache. */
  readonly preview?: boolean | undefined;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly params: URLSearchParams;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

interface PageData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly page: MemberListView | null;
  readonly denied: boolean;
  readonly flags: ViewerFlags;
  readonly seo: SeoMetadata;
}

const FORBIDDEN = "forbidden";

export async function renderMemberListRoute(input: MemberListRouteInput): Promise<{
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly status: number;
  readonly cache: RenderStatus | null;
  readonly variant: string;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly seo: SeoMetadata;
  readonly errors: readonly string[];
}> {
  const flags = await loadViewerFlags(input.sql, input.session);

  if (flags.values.member_directory !== true) {
    const notFound = await renderThemedNotFound({
      sql: input.sql,
      themeId: input.themeId,
      locale: input.locale,
      translate: input.translate,
      route: memberListContract,
    });

    return {
      ...notFound,
      status: 404,
      cache: null,
      variant: "flag-off",
      tags: [],
      etag: null,
      seo: buildSeoMetadata({
        title: input.translate("members.title"),
        boardName: "",
        description: input.translate("seo.members.description"),
        canonicalPath: "/members",
        robots: "noindex",
      }),
    };
  }

  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const allowed = await can(input.sql, principal, "members.view_list");
  const canViewHidden = await can(input.sql, principal, "members.view_hidden");
  let title = input.translate("members.title");
  let boardName = "";
  let latestSeo: SeoMetadata | null = null;

  const rendered = await renderCachedPage<PageData>({
    tags: contractTags(memberListContract, {}),
    cache: input.preview === true ? null : input.cache,
    tagVersions: input.tagVersions ?? null,
    prepare: async () => {
      const [theme, settings, flags] = await Promise.all([
        loadActiveTheme(input.sql, input.themeId),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
      ]);
      const page = allowed
        ? await buildMemberListPage({
            sql: input.sql,
            locale: input.locale,
            translate: input.translate,
            params: input.params,
            includeHidden: canViewHidden,
          })
        : null;
      const name = boardNameFrom(settings.boardName, input.translate);

      title = allowed ? (page?.title ?? title) : input.translate("theme.error.forbidden");
      boardName = name;
      latestSeo = buildSeoMetadata({
        title,
        boardName: name,
        description: input.translate("seo.members.description"),
        canonicalPath: "/members",
        robots: "noindex",
      });

      return {
        variant: pageVariant({
          route: memberListContract.route,
          params: {
            q: input.params.get("q") ?? "",
            group: input.params.get("group") ?? "",
            from: input.params.get("joinedFrom") ?? "",
            to: input.params.get("joinedTo") ?? "",
            sort: input.params.get("sort") ?? "name",
            direction: input.params.get("direction") === "desc" ? "desc" : "asc",
            page: input.params.get("page") ?? "1",
          },
          visibilityKey: `directory|allowed:${allowed ? 1 : 0}|hidden:${canViewHidden ? 1 : 0}`,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: flags.hash,
        }),
        data: { theme, boardName: name, page, denied: !allowed, flags, seo: latestSeo },
      };
    },
    render: async (data) => {
      const page = await renderThemedPage({
        sql: input.sql,
        themeId: input.themeId,
        boardName: data.boardName,
        locale: input.locale,
        translate: input.translate,
        template: data.denied ? "error" : memberListContract.templates.page,
        viewModel: data.denied
          ? {
              code: FORBIDDEN,
              message: input.translate("theme.error.forbidden"),
              flags: data.flags.values,
            }
          : { ...(data.page ?? {}), seo: data.seo, flags: data.flags.values },
        breadcrumbs: data.denied ? [] : [{ label: input.translate("members.title"), href: null }],
        route: memberListContract,
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
    status: allowed ? 200 : 403,
    seo:
      latestSeo ??
      buildSeoMetadata({
        title: allowed ? title : input.translate("theme.error.forbidden"),
        boardName,
        description: input.translate("seo.members.description"),
        canonicalPath: "/members",
        robots: "noindex",
      }),
  };
}
