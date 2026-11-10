import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { showVisibleForum } from "@bulletin/domain/forums";
import {
  CapabilityView,
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { parseResourcePath, resolveResourceUrl } from "@bulletin/domain/urls";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { forumContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { forumCapabilityDeps } from "./capability.ts";
import { buildForumPage } from "./page.ts";
import { recordRedirectClick } from "./redirects.ts";

export interface ForumRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  /** The route segment after `/forum/`, e.g. `12-general-discussion`. */
  readonly ref: string;
  readonly prefix?: string | null;
  /** The requested topic-list page (1-based). */
  readonly page?: number;
  /** Test seam for announcement transitions. */
  readonly now?: Date;
  /** Benchmark-only variant input: a unique value forces a cold render. */
  readonly bench?: number;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

interface PageRouteResult {
  readonly kind: "page";
  readonly status: number;
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly cache: RenderStatus | null;
  readonly variant: string | null;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly hasUnlockGrant: boolean;
  readonly errors: readonly string[];
}

interface RedirectRouteResult {
  readonly kind: "redirect";
  readonly status: 301 | 302;
  readonly location: string;
  readonly reason: "slug" | "forum";
}

export type ForumRouteResult = PageRouteResult | RedirectRouteResult;

interface ForumRenderData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly title: string;
  readonly page: Awaited<ReturnType<typeof buildForumPage>> | null;
  readonly error: { readonly status: 403 | 404; readonly code: "forbidden" | "not_found" } | null;
  readonly flags: ViewerFlags;
}

async function renderErrorPage(
  input: ForumRouteInput,
  status: 403 | 404,
  code: "forbidden" | "not_found",
): Promise<PageRouteResult> {
  const [theme, settings] = await Promise.all([
    loadActiveTheme(input.sql),
    readBoardSettings(input.sql),
  ]);
  const boardName = boardNameFrom(settings.boardName, input.translate);
  const title = input.translate("theme.error.title");
  const page = await renderThemedPage({
    sql: input.sql,
    boardName,
    locale: input.locale,
    translate: input.translate,
    template: "error",
    viewModel: {
      code,
      message: input.translate(`theme.error.${code === "not_found" ? "notFound" : "forbidden"}`),
    },
    breadcrumbs: [],
    route: forumContract,
    pluginsGeneration: input.pluginsGeneration,
    theme,
  });

  return {
    kind: "page",
    status,
    html: page.html,
    title,
    boardName,
    cache: null,
    variant: null,
    tags: [],
    etag: null,
    hasUnlockGrant: false,
    errors: page.errors,
  };
}

/**
 * The `/forum/<id>-<slug>` route (ADR 0001, 0005, 0006). Resolution is by ID only; a missing or
 * outdated slug permanently redirects. Redirect forums count a click and send the viewer on
 * without touching any cache tag.
 */
export async function renderForumRoute(input: ForumRouteInput): Promise<ForumRouteResult> {
  const now = input.now ?? new Date();
  const pathname = input.ref.startsWith("/forum/") ? input.ref : `/forum/${input.ref}`;
  const parsed = parseResourcePath(pathname);

  if (parsed === null || parsed.kind !== "forum") {
    return renderErrorPage(input, 404, "not_found");
  }

  const tree = await loadForumTree(input.sql);
  const forumId = String(parsed.id);

  if (tree.get(forumId) === undefined) {
    return renderErrorPage(input, 404, "not_found");
  }

  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const snapshot = await loadPermissionSnapshot(input.sql, principal, { tree, sessionId });
  const view = new CapabilityView({
    ...snapshot,
    deps: forumCapabilityDeps(tree),
    view: "forum-route",
  });
  const forum = await showVisibleForum(input.sql, view, forumId);

  if (forum === null) {
    return renderErrorPage(input, 404, "not_found");
  }

  const slug = resolveResourceUrl(parsed, forum.slug);

  if (slug.status === 301 && slug.location !== null) {
    return { kind: "redirect", status: 301, location: slug.location, reason: "slug" };
  }

  if (forum.type === "redirect" && forum.redirectUrl !== null) {
    await recordRedirectClick(input.sql, forum.id);

    return {
      kind: "redirect",
      status: 302,
      location: forum.redirectUrl,
      reason: "forum",
    };
  }

  const readable = await can(input.sql, principal, "read", {
    forumId: forum.id,
    tree,
    sessionId,
    snapshot,
  });

  if (!readable && !forum.passwordProtected) {
    return renderErrorPage(input, 403, "forbidden");
  }

  const tags = contractTags(forumContract, {
    forumId: forum.id,
    ancestorIds: tree.ancestors(forum.id).map((node) => node.id),
  });
  const prefix = input.prefix ?? null;
  let latest: ForumRenderData | undefined;

  const rendered = await renderCachedPage<ForumRenderData>({
    tags,
    cache: input.cache,
    tagVersions: input.tagVersions ?? null,
    shell: { visitor: input.session === null ? "guest" : "member" },
    prepare: async () => {
      const [theme, settings, flags, freshTree] = await Promise.all([
        loadActiveTheme(input.sql),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
        loadForumTree(input.sql),
      ]);
      // The pre-cache load only routed the request. Forum settings and permissions must be
      // reloaded here, after the cache captured tag versions, or a concurrent save can store
      // old HTML under the new tag versions.
      const freshSnapshot = await loadPermissionSnapshot(input.sql, principal, {
        tree: freshTree,
        sessionId,
      });
      const freshView = new CapabilityView({
        ...freshSnapshot,
        deps: forumCapabilityDeps(freshTree),
        view: "forum-route",
      });
      const freshForum = await showVisibleForum(input.sql, freshView, forum.id);
      let page: Awaited<ReturnType<typeof buildForumPage>> | null = null;
      let error: ForumRenderData["error"] = null;

      if (freshForum === null) {
        error = { status: 404, code: "not_found" };
      } else {
        const freshReadable = await can(input.sql, principal, "read", {
          forumId: freshForum.id,
          tree: freshTree,
          sessionId,
          snapshot: freshSnapshot,
        });

        if (!freshReadable && !freshForum.passwordProtected) {
          error = { status: 403, code: "forbidden" };
        } else {
          page = await buildForumPage({
            sql: input.sql,
            locale: input.locale,
            translate: input.translate,
            principal,
            sessionId,
            snapshot: freshSnapshot,
            forum: freshForum,
            prefix,
            page: input.page ?? 1,
            topicsPerPage: settings.topicsPerPage,
            now,
            announcementsEnabled: flags.values.announcements === true,
            mentionsEnabled: flags.values.mentions === true,
          });
        }
      }

      const boardName = boardNameFrom(settings.boardName, input.translate);
      const data: ForumRenderData = {
        theme,
        boardName,
        title: page?.viewModel.title ?? input.translate("theme.error.title"),
        page,
        error,
        flags,
      };

      latest = data;

      return {
        variant: pageVariant({
          route: forumContract.route,
          params: {
            id: forum.id,
            prefix: page?.viewModel.activePrefix ?? "",
            page: page?.viewModel.pagination.page ?? 1,
            ...(input.bench === undefined || input.bench === 0 ? {} : { bench: input.bench }),
          },
          visibilityKey: page?.visibilityKey ?? `error:${freshView.visibilityKey()}`,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: flags.hash,
        }),
        data,
        ...(page?.ttlMs === null || page?.ttlMs === undefined ? {} : { ttlMs: page.ttlMs }),
      };
    },
    render: async (data) => {
      const page = await renderThemedPage({
        sql: input.sql,
        boardName: data.boardName,
        locale: input.locale,
        translate: input.translate,
        template: data.error === null ? forumContract.templates.page : "error",
        viewModel:
          data.error === null
            ? (data.page?.viewModel ?? {})
            : {
                code: data.error.code,
                message: input.translate(
                  `theme.error.${data.error.code === "not_found" ? "notFound" : "forbidden"}`,
                ),
              },
        breadcrumbs: data.error === null ? (data.page?.breadcrumbs ?? []) : [],
        route: forumContract,
        pluginsGeneration: input.pluginsGeneration,
        theme: data.theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  if (latest === undefined) {
    throw new Error("The forum route prepared no view model");
  }

  return {
    kind: "page",
    status: latest.error?.status ?? 200,
    html: rendered.html,
    title: latest.title,
    boardName: latest.boardName,
    cache: rendered.cache,
    variant: rendered.variant,
    tags: rendered.tags,
    etag: rendered.etag,
    hasUnlockGrant: latest.page?.hasUnlockGrant ?? false,
    errors: rendered.errors,
  };
}
