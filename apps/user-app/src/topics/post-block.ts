import type { RenderCache } from "@bulletin/cache";
import { postTag } from "@bulletin/cache";
import type { Locale, Translator } from "@bulletin/i18n";
import { type LoadedTheme, themeContentKey } from "@bulletin/templates";
import type { SQL } from "bun";
import { renderThemedPage } from "../theme/render.ts";
import type { TopicPagePost } from "./page.ts";

export interface PostBlockInput {
  readonly sql: SQL;
  readonly cache: RenderCache;
  readonly theme: LoadedTheme | null;
  readonly post: TopicPagePost;
  /** Reloads the current block model inside `prepare`, after tag versions are captured. */
  readonly loadPost: (postId: string) => Promise<TopicPagePost | null>;
  readonly visibilityKey: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly pluginsGeneration: number;
  readonly colourScheme: string;
  readonly flagsHash: string;
  /** Evaluated render flags exposed to the post template (e.g. `flags.attachments`). */
  readonly flags: Readonly<Record<string, boolean>>;
  readonly tags: readonly string[];
}

/** One independently cached post block; edits bump `post:{id}` only. */
export async function renderPostBlock(input: PostBlockInput): Promise<string> {
  const rendered = await input.cache.getOrRender({
    tags: [...new Set([postTag(input.post.id), ...input.tags])],
    prepare: async () => ({
      key: `post-block:${input.post.id}:${input.visibilityKey}:${input.theme?.theme.id ?? "0"}@${
        input.theme?.theme.version ?? 0
      }:${input.theme === null ? "" : themeContentKey(input.theme)}:${input.locale}:${
        input.colourScheme
      }:${input.pluginsGeneration}:${input.flagsHash}`,
      data: await input.loadPost(input.post.id),
    }),
    render: async (post) => {
      // The post may have been deleted or hidden after the page prepared.
      if (post === null) {
        return "";
      }

      const page = await renderThemedPage({
        sql: input.sql,
        boardName: "",
        locale: input.locale,
        translate: input.translate,
        template: "post",
        viewModel: { post, flags: input.flags },
        breadcrumbs: [],
        route: { route: "/topic/[ref]", requiredIslands: [] },
        pluginsGeneration: input.pluginsGeneration,
        theme: input.theme,
        regions: [],
      });

      return page.html;
    },
  });

  return rendered.html;
}
