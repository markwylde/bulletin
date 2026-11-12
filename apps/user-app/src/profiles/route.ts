import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { loadReplaceWords } from "@bulletin/domain/filters";
import {
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { readProfile } from "@bulletin/domain/profiles";
import { canonicalUrl, parseResourcePath, resolveResourceUrl } from "@bulletin/domain/urls";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { profileContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { buildProfilePage, type ProfilePageData } from "./page.ts";

/**
 * Last-active is visit data written without a tag bump (ADR 0006). A short fragment TTL keeps
 * a warmed profile from showing a stale timestamp forever without turning visits into writes
 * that invalidate content caches.
 */
export const PROFILE_FRAGMENT_TTL_MS = 60_000;

export interface ProfileRouteInput {
  readonly sql: SQL;
  /** The preview or guest-chosen theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
  /** Preview responses are private and never stored in the shared fragment cache. */
  readonly preview?: boolean | undefined;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  /** The route segment after `/profile/`, e.g. `77-jane`. */
  readonly ref: string;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

interface ProfilePageRouteResult {
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

interface ProfileRedirectRouteResult {
  readonly kind: "redirect";
  readonly status: 301;
  readonly location: string;
}

export type ProfileRouteResult = ProfilePageRouteResult | ProfileRedirectRouteResult;

interface ProfileRenderData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly page: ProfilePageData | null;
  readonly flags: ViewerFlags;
}

async function renderErrorPage(
  input: ProfileRouteInput,
  status: 404,
): Promise<ProfilePageRouteResult> {
  const [theme, settings] = await Promise.all([
    loadActiveTheme(input.sql, input.themeId),
    readBoardSettings(input.sql),
  ]);
  const boardName = boardNameFrom(settings.boardName, input.translate);
  const page = await renderThemedPage({
    sql: input.sql,
    themeId: input.themeId,
    boardName,
    locale: input.locale,
    translate: input.translate,
    template: "error",
    viewModel: {
      code: "not_found",
      message: input.translate("theme.error.notFound"),
    },
    breadcrumbs: [],
    route: profileContract,
    pluginsGeneration: input.pluginsGeneration,
    theme,
  });

  return {
    kind: "page",
    status,
    html: page.html,
    title: input.translate("theme.error.title"),
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
 * The public `/profile/<id>-<slug>` route (ADR 0001, 0005, 0006). The variant carries the
 * viewer's field-visibility class and the read bits of forums whose posts may appear in the
 * recent list, so a less privileged viewer never receives another variant's HTML.
 */
export async function renderProfileRoute(input: ProfileRouteInput): Promise<ProfileRouteResult> {
  const pathname = input.ref.startsWith("/profile/") ? input.ref : `/profile/${input.ref}`;
  const parsed = parseResourcePath(pathname);

  if (parsed === null || parsed.kind !== "profile") {
    return renderErrorPage(input, 404);
  }

  const memberId = String(parsed.id);
  const profile = await readProfile(input.sql, memberId);

  if (profile === null || profile.displayName === null) {
    return renderErrorPage(input, 404);
  }

  const slug = resolveResourceUrl(parsed, profile.displayName);

  if (slug.status === 301 && slug.location !== null) {
    return { kind: "redirect", status: 301, location: slug.location };
  }

  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const tags = contractTags(profileContract, { memberId });
  let title = profile.displayName;
  let boardName = "";
  let hasUnlockGrant = false;

  const rendered = await renderCachedPage<ProfileRenderData>({
    tags,
    cache: input.preview === true ? null : input.cache,
    tagVersions: input.tagVersions ?? null,
    shell: { visitor: input.session === null ? "guest" : "member" },
    // Last-active activity changes inside the fragment TTL without moving `member:{id}`, so
    // the ETag must cover the rendered HTML or revalidation keeps the stale activity.
    contentValidator: true,
    prepare: async () => {
      const [theme, settings, flags, tree, replaceWords] = await Promise.all([
        loadActiveTheme(input.sql, input.themeId),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
        loadForumTree(input.sql),
        loadReplaceWords(input.sql),
      ]);
      const snapshot = await loadPermissionSnapshot(input.sql, principal, {
        tree,
        sessionId,
      });
      const page = await buildProfilePage({
        sql: input.sql,
        memberId,
        principal,
        sessionId,
        tree,
        snapshot,
        locale: input.locale,
        translate: input.translate,
        replaceWords,
      });
      const boardName = boardNameFrom(settings.boardName, input.translate);

      title = page?.title ?? input.translate("theme.error.title");
      hasUnlockGrant = page?.hasUnlockGrant === true;

      return {
        variant: pageVariant({
          route: profileContract.route,
          params: { id: memberId },
          visibilityKey: page?.visibilityKey ?? "profile:unavailable",
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: flags.hash,
        }),
        data: { theme, boardName, page, flags },
        ttlMs: PROFILE_FRAGMENT_TTL_MS,
      };
    },
    render: async (data) => {
      boardName = data.boardName;
      const page = await renderThemedPage({
        sql: input.sql,
        themeId: input.themeId,
        boardName: data.boardName,
        locale: input.locale,
        translate: input.translate,
        template: data.page === null ? "error" : profileContract.templates.page,
        viewModel:
          data.page === null
            ? {
                code: "not_found",
                message: input.translate("theme.error.notFound"),
                flags: data.flags.values,
              }
            : { ...data.page.viewModel, flags: data.flags.values },
        breadcrumbs: data.page?.breadcrumbs ?? [],
        route: profileContract,
        pluginsGeneration: input.pluginsGeneration,
        theme: data.theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  return {
    ...rendered,
    kind: "page",
    status: 200,
    title,
    boardName,
    hasUnlockGrant,
  };
}

/** The canonical URL for a profile, used by links and the staff app. */
export function profileHref(memberId: string, displayName: string): string {
  return canonicalUrl("profile", memberId, displayName);
}
