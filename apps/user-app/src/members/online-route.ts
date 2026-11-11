import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import {
  CapabilityView,
  can,
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { onlineContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { renderThemedNotFound } from "../theme/not-found.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { buildOnlinePage, type OnlinePageView } from "./online.ts";

export interface OnlineRouteInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  readonly tagVersions?: TagVersionSource | null;
}

interface OnlineData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly page: OnlinePageView;
  readonly flags: ViewerFlags;
}

export async function renderOnlineRoute(input: OnlineRouteInput): Promise<{
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly cache: RenderStatus | null;
  readonly variant: string;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly hasUnlockGrant: boolean;
  readonly errors: readonly string[];
}> {
  const flags = await loadViewerFlags(input.sql, input.session);

  if (flags.values.whos_online !== true) {
    const notFound = await renderThemedNotFound({
      sql: input.sql,
      locale: input.locale,
      translate: input.translate,
      route: onlineContract,
    });

    return {
      ...notFound,
      cache: null,
      variant: "flag-off",
      tags: [],
      etag: null,
      hasUnlockGrant: false,
    };
  }

  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const tree = await loadForumTree(input.sql);
  const snapshot = await loadPermissionSnapshot(input.sql, principal, { tree, sessionId });
  const canViewHidden = await can(input.sql, principal, "members.view_hidden");
  const view = new CapabilityView({
    ...snapshot,
    deps: tree.ids.map((forumId) => ({ forumId, bit: "read" as const })),
    view: "online",
  });
  let title = input.translate("online.title");
  let boardName = "";
  let hasUnlockGrant = false;

  const rendered = await renderCachedPage<OnlineData>({
    tags: contractTags(onlineContract, {}),
    cache: input.cache,
    tagVersions: input.tagVersions ?? null,
    shell: { visitor: input.session === null ? "guest" : "member" },
    prepare: async () => {
      const [theme, settings, flags] = await Promise.all([
        loadActiveTheme(input.sql),
        readBoardSettings(input.sql),
        loadViewerFlags(input.sql, input.session),
      ]);
      const page = await buildOnlinePage({
        sql: input.sql,
        locale: input.locale,
        translate: input.translate,
        principal,
        sessionId,
        tree,
        snapshot,
        canViewHidden,
      });
      const name = boardNameFrom(settings.boardName, input.translate);
      title = page.title;
      boardName = name;
      hasUnlockGrant = view.hasUnlockGrant;

      return {
        variant: pageVariant({
          route: onlineContract.route,
          visibilityKey: `${view.visibilityKey()}|hidden:${canViewHidden ? 1 : 0}`,
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: flags.hash,
        }),
        data: { theme, boardName: name, page, flags },
        ttlMs: 60_000,
      };
    },
    render: async (data) => {
      const page = await renderThemedPage({
        sql: input.sql,
        boardName: data.boardName,
        locale: input.locale,
        translate: input.translate,
        template: onlineContract.templates.page,
        viewModel: { ...data.page, flags: data.flags.values },
        breadcrumbs: [{ label: input.translate("online.title"), href: null }],
        route: onlineContract,
        pluginsGeneration: input.pluginsGeneration,
        theme: data.theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });

  return { ...rendered, title, boardName, hasUnlockGrant };
}
