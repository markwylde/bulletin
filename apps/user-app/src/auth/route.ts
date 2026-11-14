import type { RenderCache } from "@bulletin/cache";
import type { ColorScheme, Locale, Translator } from "@bulletin/i18n";
import { contractTags, type LoadedTheme, type ViewModelContract } from "@bulletin/templates";
import type { SQL } from "bun";
import type { ShellVariant } from "../http/cache.ts";
import { type CachedPageResult, pageVariant, renderCachedPage } from "../theme/cached-route.ts";
import { loadActiveTheme, renderThemedPage } from "../theme/render.ts";

export interface AuthRouteInput {
  readonly sql: SQL;
  /** The preview or guest-chosen theme; null means the bundled default. */
  readonly themeId?: string | null | undefined;
  /** Preview responses are private and never stored in the shared fragment cache. */
  readonly preview?: boolean | undefined;
  readonly boardName: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly template: string;
  readonly contract: ViewModelContract;
  readonly pluginsGeneration: number;
  readonly colourScheme: ColorScheme;
  readonly cache: RenderCache;
  /** Guest and member shells differ, so their ETags must too. */
  readonly shell?: ShellVariant;
  /** Template flags for the page; the auth shells render every flag off by default. */
  readonly renderFlags?: Readonly<Record<string, boolean>>;
}

interface AuthData {
  readonly theme: LoadedTheme | null;
}

/**
 * The sign-in and callback shells through the shared page pipeline (ADR 0006). Their HTML is
 * shared, so the variant key is public; their responses stay `no-store`, so no ETag is issued.
 */
export async function renderAuthRoute(input: AuthRouteInput): Promise<CachedPageResult> {
  return renderCachedPage<AuthData>({
    tags: contractTags(input.contract, {}),
    cache: input.preview === true ? null : input.cache,
    tagVersions: null,
    ...(input.shell === undefined ? {} : { shell: input.shell }),
    prepare: async () => {
      const theme = await loadActiveTheme(input.sql, input.themeId);

      return {
        variant: pageVariant({
          route: input.contract.route,
          visibilityKey: "public",
          theme,
          pluginsGeneration: input.pluginsGeneration,
          locale: input.locale,
          colourScheme: input.colourScheme,
          renderFlagsHash: "",
        }),
        data: { theme },
      };
    },
    render: async ({ theme }) => {
      const page = await renderThemedPage({
        sql: input.sql,
        themeId: input.themeId,
        boardName: input.boardName,
        locale: input.locale,
        translate: input.translate,
        template: input.template,
        viewModel: { flags: input.renderFlags ?? {} },
        breadcrumbs: [],
        route: input.contract,
        pluginsGeneration: input.pluginsGeneration,
        theme,
      });

      return { html: page.html, errors: page.errors };
    },
  });
}
