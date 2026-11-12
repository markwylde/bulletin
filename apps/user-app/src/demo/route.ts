import type { RenderCache, RenderStatus, TagVersionSource } from "@bulletin/cache";
import { readBoardSettings } from "@bulletin/domain/board";
import { FIXTURE_FORUM_TREE } from "@bulletin/domain/permissions/fixtures";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme } from "@bulletin/templates";
import type { SQL } from "bun";
import { DEMO_SHELL_ISLANDS, demoContract } from "../contracts.ts";
import { loadViewerFlags, type ViewerFlags } from "../flags.ts";
import type { UserAppSessionContext } from "../session.ts";
import { pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "../theme/render.ts";
import { buildDemoPage, type DemoOutcome } from "./page.ts";

export interface DemoRouteInput {
  readonly sql: SQL;
  /** The preview or guest-chosen theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
  /** Preview responses are private and never stored in the shared fragment cache. */
  readonly preview?: boolean | undefined;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  readonly forumId: string;
  readonly showDeleted: boolean;
  /** Benchmark-only variant input: a unique value forces a cold render (task 7.1). */
  readonly bench?: number;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  /** Needed for the ETag; while untrusted the response carries no ETag (ADR 0006). */
  readonly tagVersions?: TagVersionSource | null;
}

export interface DemoRouteResult {
  readonly status: number;
  readonly html: string;
  readonly title: string;
  /** The board name the rendered HTML carries, for the document title. */
  readonly boardName: string;
  /** Null when the page is not shared-cacheable (an unknown forum id). */
  readonly cache: RenderStatus | null;
  readonly variant: string | null;
  readonly tags: readonly string[];
  readonly etag: string | null;
  readonly hasUnlockGrant: boolean;
  readonly clientFlagsJson: string;
  readonly errors: readonly string[];
}

/** Everything the demo HTML and its variant key need, loaded after the cache's snapshot. */
interface DemoData {
  readonly theme: LoadedTheme | null;
  readonly boardName: string;
  readonly flags: ViewerFlags;
  readonly outcome: DemoOutcome;
}

/**
 * Renders the demo route through the tagged fragment cache (ADR 0006, task 5.4). The variant
 * key carries every dimension that can change the HTML; `forum:{id}` and the board shell tags
 * invalidate it.
 */
export async function renderDemoRoute(input: DemoRouteInput): Promise<DemoRouteResult> {
  const loadData = async (): Promise<DemoData> => {
    const [theme, flags, settings, outcome] = await Promise.all([
      loadActiveTheme(input.sql, input.themeId),
      loadViewerFlags(input.sql, input.session),
      readBoardSettings(input.sql),
      buildDemoPage({
        sql: input.sql,
        locale: input.locale,
        translate: input.translate,
        session: input.session,
        forumId: input.forumId,
        showDeleted: input.showDeleted,
      }),
    ]);

    return {
      theme,
      boardName: boardNameFrom(settings.boardName, input.translate),
      flags,
      outcome,
    };
  };

  const variantFor = (data: DemoData): string => {
    const visibilityKey = data.outcome.visibilityKey;

    if (visibilityKey === null) {
      throw new Error(`Forum "${input.forumId}" has no visibility key`);
    }

    return pageVariant({
      route: demoContract.route,
      params: {
        id: input.forumId,
        deleted: data.outcome.showDeleted ? "1" : "0",
        ...(input.bench === undefined || input.bench === 0 ? {} : { bench: input.bench }),
      },
      visibilityKey,
      theme: data.theme,
      pluginsGeneration: input.pluginsGeneration,
      locale: input.locale,
      colourScheme: input.colourScheme,
      renderFlagsHash: data.flags.hash,
    });
  };

  const renderOutcome = async (data: DemoData) => {
    const flags = {
      ...data.flags.values,
      compactTopicList: data.flags.values.compactTopicList === true,
      mentions: data.flags.values.mentions === true,
      unfurls: data.flags.values.unfurls === true,
      attachments: data.flags.values.attachments === true,
    };

    const viewModel: Record<string, unknown> = { ...data.outcome.viewModel, flags };
    const editor = viewModel.editor;

    if (typeof editor === "object" && editor !== null && !Array.isArray(editor)) {
      viewModel.editor = {
        ...editor,
        flags: { mentions: flags.mentions, attachments: flags.attachments },
      };
    }

    return renderThemedPage({
      sql: input.sql,
      themeId: input.themeId,
      boardName: data.boardName,
      locale: input.locale,
      translate: input.translate,
      template: data.outcome.template,
      viewModel,
      breadcrumbs: data.outcome.breadcrumbs,
      route: {
        route: demoContract.route,
        requiredIslands:
          data.outcome.state === "content" ? demoContract.requiredIslands : DEMO_SHELL_ISLANDS,
      },
      pluginsGeneration: input.pluginsGeneration,
      theme: data.theme,
    });
  };

  if (input.forumId !== "editor" && FIXTURE_FORUM_TREE.get(input.forumId) === undefined) {
    // An unknown forum id is a 404 page; nothing is shared or cached for it.
    const data = await loadData();
    const page = await renderOutcome(data);

    return {
      status: 404,
      html: page.html,
      title: data.outcome.title,
      boardName: data.boardName,
      cache: null,
      variant: null,
      tags: [],
      etag: null,
      hasUnlockGrant: data.outcome.hasUnlockGrant,
      clientFlagsJson: JSON.stringify(data.flags.clientFlags),
      errors: page.errors,
    };
  }

  // `prepare` also runs on a hit, so this holds the data the final key was built from.
  let latest: DemoData | undefined;
  const rendered = await renderCachedPage<DemoData>({
    tags: contractTags(demoContract, {
      forumId: input.forumId,
      embedsEditor: input.forumId === "editor",
    }),
    cache: input.preview === true ? null : input.cache,
    tagVersions: input.tagVersions ?? null,
    shell: { visitor: input.session === null ? "guest" : "member" },
    prepare: async () => {
      const data = await loadData();
      latest = data;

      return { variant: variantFor(data), data };
    },
    render: async (data) => {
      const page = await renderOutcome(data);
      return { html: page.html, errors: page.errors };
    },
  });

  if (latest === undefined) {
    throw new Error("The demo route prepared no view model");
  }

  return {
    status: latest.outcome.template === "error" ? latest.outcome.status : 200,
    html: rendered.html,
    title: latest.outcome.title,
    boardName: latest.boardName,
    cache: rendered.cache,
    variant: rendered.variant,
    tags: rendered.tags,
    etag: rendered.etag,
    hasUnlockGrant: latest.outcome.hasUnlockGrant,
    clientFlagsJson: JSON.stringify(latest.flags.clientFlags),
    errors: rendered.errors,
  };
}
