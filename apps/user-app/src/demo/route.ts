import {
  forumTag,
  type RenderCache,
  type RenderStatus,
  type TagVersionSource,
  variantKey,
} from "@bulletin/cache";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import type { LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { DEMO_SHELL_ISLANDS, demoContract } from "../contracts.ts";
import type { ViewerFlags } from "../flags.ts";
import { etagFor } from "../http/cache.ts";
import type { UserAppSessionContext } from "../session.ts";
import { renderThemedPage } from "../theme/render.ts";
import { buildDemoPage } from "./page.ts";

export interface DemoRouteInput {
  readonly sql: SQL;
  readonly boardName: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly forumId: string;
  readonly showDeleted: boolean;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly theme: LoadedTheme | null;
  readonly flags: ViewerFlags;
  readonly cache: RenderCache;
  /** Needed for the ETag; while untrusted the response carries no ETag (ADR 0006). */
  readonly tagVersions?: TagVersionSource | null;
}

export interface DemoRouteResult {
  readonly status: number;
  readonly html: string;
  readonly title: string;
  /** Null when the page is not shared-cacheable (an unknown forum id). */
  readonly cache: RenderStatus | null;
  readonly variant: string | null;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly hasUnlockGrant: boolean;
  readonly errors: readonly string[];
}

/**
 * Renders the demo route through the tagged fragment cache (ADR 0006, task 5.4). The variant
 * key carries every dimension that can change the HTML; only `forum:{id}` invalidates it.
 */
export async function renderDemoRoute(input: DemoRouteInput): Promise<DemoRouteResult> {
  const outcome = await buildDemoPage({
    sql: input.sql,
    locale: input.locale,
    translate: input.translate,
    session: input.session,
    forumId: input.forumId,
    showDeleted: input.showDeleted,
  });
  const viewer = {
    isMember: input.session !== null,
    displayName: input.session?.displayName ?? null,
  };
  const flags = { compactTopicList: input.flags.values.compactTopicList === true };
  const render = () =>
    renderThemedPage({
      sql: input.sql,
      boardName: input.boardName,
      viewer,
      locale: input.locale,
      translate: input.translate,
      template: outcome.template,
      viewModel: { ...outcome.viewModel, flags },
      breadcrumbs: outcome.breadcrumbs,
      route: {
        route: demoContract.route,
        requiredIslands:
          outcome.state === "content" ? demoContract.requiredIslands : DEMO_SHELL_ISLANDS,
      },
      pluginsGeneration: input.pluginsGeneration,
      theme: input.theme,
    });

  if (outcome.visibilityKey === null) {
    // An unknown forum id is a 404 page; nothing is shared or cached for it.
    const page = await render();

    return {
      status: 404,
      html: page.html,
      title: outcome.title,
      cache: null,
      variant: null,
      tags: [],
      etag: null,
      hasUnlockGrant: outcome.hasUnlockGrant,
      errors: page.errors,
    };
  }

  const variant = variantKey({
    route: demoContract.route,
    params: { id: input.forumId, deleted: outcome.showDeleted ? "1" : "0" },
    visibilityKey: outcome.visibilityKey,
    themeId: input.theme?.theme.id ?? "0",
    themeVersion: input.theme?.theme.version ?? 0,
    pluginsGeneration: input.pluginsGeneration,
    locale: input.locale,
    colourScheme: input.colourScheme,
    renderFlagsHash: input.flags.hash,
  });
  const tags = [forumTag(input.forumId)];
  let errors: readonly string[] = [];
  const rendered = await input.cache.getOrRender({
    key: variant,
    tags,
    render: async () => {
      const page = await render();
      errors = page.errors;
      return page.html;
    },
  });

  const source = input.tagVersions ?? null;
  const etag =
    source !== null && source.isTrusted()
      ? etagFor(variant, new Map(tags.map((tag) => [tag, source.version(tag)])))
      : null;

  return {
    status: outcome.template === "error" ? outcome.status : 200,
    html: rendered.html,
    title: outcome.title,
    cache: rendered.status,
    variant,
    tags,
    etag,
    hasUnlockGrant: outcome.hasUnlockGrant,
    errors,
  };
}
