import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { moderationWarningsContract, warningsContract } from "../contracts.ts";
import { loadViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, renderThemedPage } from "../theme/render.ts";
import { buildOwnWarningsPage, buildStaffWarningsPage } from "./page.ts";

export interface WarningsRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  /** The board's configured name, when the caller has loaded it. */
  readonly boardName?: string | null;
}

export interface WarningsPageResult {
  readonly status: 200 | 403 | 404;
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly errors: readonly string[];
}

function pageResult(
  status: WarningsPageResult["status"],
  html: string,
  title: string,
  boardName: string,
  errors: readonly string[],
): WarningsPageResult {
  return { status, html, title, boardName, errors };
}

/** The member's own warnings; a themed 404 while the `warnings` flag is off (ADR 0010). */
export async function renderOwnWarningsRoute(
  input: WarningsRouteInput,
): Promise<WarningsPageResult> {
  const flags = await loadViewerFlags(input.sql, input.session);

  if (flags.values.warnings !== true) {
    const notFound = await renderThemedNotFound({
      sql: input.sql,
      locale: input.locale,
      translate: input.translate,
      route: warningsContract,
    });

    return pageResult(404, notFound.html, notFound.title, notFound.boardName, notFound.errors);
  }

  const boardName = boardNameFrom(input.boardName ?? null, input.translate);
  const page = await buildOwnWarningsPage({
    sql: input.sql,
    memberId: input.session.memberId,
    locale: input.locale,
    translate: input.translate,
  });
  const rendered = await renderCachedPage({
    tags: [`member:${input.session.memberId}`],
    cache: null,
    tagVersions: null,
    shell: { visitor: "member", authState: "authenticated" },
    prepare: async () => ({
      variant: pageVariant({
        route: warningsContract.route,
        visibilityKey: "member",
        theme: null,
        pluginsGeneration: input.pluginsGeneration,
        locale: input.locale,
        colourScheme: input.colourScheme,
        renderFlagsHash: flags.hash,
      }),
      data: undefined,
    }),
    render: async () => {
      const themed = await renderThemedPage({
        sql: input.sql,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: warningsContract.templates.page,
        viewModel: { ...page.viewModel, title: page.title, flags: flags.values },
        breadcrumbs: page.breadcrumbs,
        route: warningsContract,
      });

      return { html: themed.html, errors: themed.errors };
    },
  });

  return pageResult(200, rendered.html, page.title, boardName, rendered.errors);
}

/** Staff warning history for one member; 404 while the flag is off, 403 without permission. */
export async function renderStaffWarningsRoute(
  input: WarningsRouteInput & { readonly memberId: string },
): Promise<WarningsPageResult> {
  const flags = await loadViewerFlags(input.sql, input.session);

  if (flags.values.warnings !== true) {
    const notFound = await renderThemedNotFound({
      sql: input.sql,
      locale: input.locale,
      translate: input.translate,
      route: moderationWarningsContract,
    });

    return pageResult(404, notFound.html, notFound.title, notFound.boardName, notFound.errors);
  }

  const boardName = boardNameFrom(input.boardName ?? null, input.translate);
  const page = /^\d+$/.test(input.memberId)
    ? await buildStaffWarningsPage({
        sql: input.sql,
        actorId: input.session.memberId,
        sessionId: input.session.sessionId,
        memberId: input.memberId,
        locale: input.locale,
        translate: input.translate,
      })
    : null;

  if (page === null) {
    const themed = await renderThemedPage({
      sql: input.sql,
      boardName,
      locale: input.locale,
      translate: input.translate,
      template: "error",
      viewModel: {
        code: "forbidden",
        message: input.translate("theme.error.forbidden"),
        flags: flags.values,
      },
      breadcrumbs: [],
      route: moderationWarningsContract,
    });

    return pageResult(
      403,
      themed.html,
      input.translate("theme.error.title"),
      boardName,
      themed.errors,
    );
  }

  const rendered = await renderCachedPage({
    tags: [`member:${input.memberId}`],
    cache: null,
    tagVersions: null,
    shell: { visitor: "member", authState: "authenticated" },
    prepare: async () => ({
      variant: pageVariant({
        route: moderationWarningsContract.route,
        params: { memberId: input.memberId },
        visibilityKey: "member",
        theme: null,
        pluginsGeneration: input.pluginsGeneration,
        locale: input.locale,
        colourScheme: input.colourScheme,
        renderFlagsHash: flags.hash,
      }),
      data: undefined,
    }),
    render: async () => {
      const themed = await renderThemedPage({
        sql: input.sql,
        boardName,
        locale: input.locale,
        translate: input.translate,
        template: moderationWarningsContract.templates.page,
        viewModel: { ...page.viewModel, title: page.title, flags: flags.values },
        breadcrumbs: page.breadcrumbs,
        route: moderationWarningsContract,
      });

      return { html: themed.html, errors: themed.errors };
    },
  });

  return pageResult(200, rendered.html, page.title, boardName, rendered.errors);
}
