import { readBoardSettings } from "@bulletin/domain/board";
import {
  CapabilityView,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { searchContract, searchMemberContract, searchNewContract } from "../contracts.ts";
import { loadViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { searchCapabilityDeps } from "./capability.ts";
import {
  buildMemberContentPage,
  buildNewContentPage,
  buildSearchPage,
  type SearchView,
} from "./page.ts";

export type SearchRouteMode = "search" | "member" | "new";

export interface SearchRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly params: URLSearchParams;
  readonly mode: SearchRouteMode;
  /** The member ref for the content-by-member route. */
  readonly ref?: string;
}

export type SearchRouteResult =
  | {
      readonly kind: "page";
      readonly status: 200 | 404;
      readonly html: string;
      readonly title: string;
      readonly boardName: string;
      readonly errors: readonly string[];
    }
  | { readonly kind: "redirect"; readonly status: 303; readonly location: string };

const CONTRACTS = {
  search: searchContract,
  member: searchMemberContract,
  new: searchNewContract,
} as const;

function breadcrumbsFor(
  mode: SearchRouteMode,
  view: SearchView,
  translate: Translator,
): readonly { readonly label: string; readonly href: string | null }[] {
  const items = [{ label: translate("search.title"), href: mode === "search" ? null : "/search" }];

  if (mode === "member" && view.member !== null) {
    items.push({ label: view.member.name, href: view.member.href });
    items.push({ label: translate("search.member.crumb"), href: null });
  } else if (mode === "new") {
    items.push({ label: translate("search.new.crumb"), href: null });
  }

  return items;
}

/**
 * Renders the public search page and the two activity views (ADR 0017). Results depend on the
 * viewer and the query, so these routes are private and never enter the shared cache.
 */
export async function renderSearchRoute(input: SearchRouteInput): Promise<SearchRouteResult> {
  const contract = CONTRACTS[input.mode];

  if (input.mode === "new" && input.session === null) {
    return {
      kind: "redirect",
      status: 303,
      location: `/auth/login?return_to=${encodeURIComponent("/search/new")}`,
    };
  }

  const tree = await loadForumTree(input.sql);
  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const snapshot = await loadPermissionSnapshot(input.sql, principal, { tree, sessionId });
  const capability = new CapabilityView({
    ...snapshot,
    deps: searchCapabilityDeps(tree),
    view: "search-route",
  });
  const [theme, settings, flags] = await Promise.all([
    loadActiveTheme(input.sql),
    readBoardSettings(input.sql),
    loadViewerFlags(input.sql, input.session),
  ]);
  const boardName = boardNameFrom(settings.boardName, input.translate);
  const common = {
    sql: input.sql,
    locale: input.locale,
    translate: input.translate,
    principal,
    capability,
    params: input.params,
  };
  const view =
    input.mode === "search"
      ? await buildSearchPage(common)
      : input.mode === "member"
        ? await buildMemberContentPage({ ...common, ref: input.ref ?? "" })
        : await buildNewContentPage({ ...common, memberId: principal as string });

  if (view === null) {
    const notFound = await renderThemedNotFound({
      sql: input.sql,
      locale: input.locale,
      translate: input.translate,
      route: contract,
    });

    return { ...notFound, kind: "page", status: 404 };
  }

  const page = await renderThemedPage({
    sql: input.sql,
    boardName,
    locale: input.locale,
    translate: input.translate,
    template: contract.templates.page,
    viewModel: { ...view, flags: flags.values },
    breadcrumbs: breadcrumbsFor(input.mode, view, input.translate),
    route: contract,
    theme,
  });

  return {
    kind: "page",
    status: 200,
    html: page.html,
    title: view.title,
    boardName,
    errors: page.errors,
  };
}
