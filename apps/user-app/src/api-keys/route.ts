import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { can } from "@bulletin/domain/permissions";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags } from "@bulletin/templates";
import type { SQL } from "bun";
import { apiKeysContract } from "../contracts.ts";
import { loadViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, renderThemedPage } from "../theme/render.ts";

export interface ApiKeysRouteInput {
  readonly sql: SQL;
  readonly themeId?: string | null | undefined;
  readonly preview?: boolean | undefined;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

/** The member's personal key page, available only with the flag and group setting on. */
export async function renderApiKeysRoute(input: ApiKeysRouteInput): Promise<{
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly cache: RenderStatus | null;
  readonly variant: string;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly errors: readonly string[];
  readonly status: number;
}> {
  const flags = await loadViewerFlags(input.sql, input.session);
  const enabled =
    flags.values.public_api === true &&
    (await can(input.sql, input.session.memberId, "create_personal_api_keys"));
  const notFound = enabled
    ? null
    : await renderThemedNotFound({
        sql: input.sql,
        themeId: input.themeId,
        locale: input.locale,
        translate: input.translate,
        route: apiKeysContract,
      });
  const title = input.translate("apiKeys.title");
  let boardName = "";

  const rendered = await renderCachedPage({
    tags: contractTags(apiKeysContract, { memberId: input.session.memberId }),
    // Personal key metadata is never stored in the shared fragment cache (ADR 0006).
    cache: null,
    tagVersions: null,
    shell: { visitor: "member", authState: "authenticated" },
    prepare: async () => {
      const [settings, latest] = await Promise.all([
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
      ]);
      const name = boardNameFrom(settings.boardName, input.translate);
      boardName = name;

      return {
        variant: pageVariant({
          route: apiKeysContract.route,
          visibilityKey: "member",
          theme: null,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: latest.hash,
        }),
        data: undefined,
      };
    },
    render: async () => {
      if (!enabled || notFound !== null) {
        if (notFound === null) {
          throw new Error("missing not-found page");
        }

        return { html: notFound.html, errors: notFound.errors };
      }

      const latest = await loadViewerFlags(input.sql, input.session);
      const themed = await renderThemedPage({
        sql: input.sql,
        themeId: input.themeId,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: apiKeysContract.templates.page,
        viewModel: { flags: latest.values },
        breadcrumbs: [{ label: title, href: null }],
        route: apiKeysContract,
      });

      return { html: themed.html, errors: themed.errors };
    },
  });

  return {
    ...rendered,
    title: enabled ? title : (notFound?.title ?? title),
    boardName,
    status: enabled ? 200 : 404,
  };
}
