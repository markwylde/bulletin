import { GLOBAL_CACHE_TAGS, i18nTag, postReactionsTag, type RenderCache } from "@bulletin/cache";
import { listReactions, readReactionSummary } from "@bulletin/domain/reactions";
import type { Locale, Translator } from "@bulletin/i18n";
import { islandMarkup } from "@bulletin/templates";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";
import type { SQL } from "bun";

export interface ReactionBarInput {
  readonly sql: SQL;
  readonly cache: RenderCache;
  readonly postId: string;
  readonly locale: Locale;
  readonly translate: Translator;
  /** A member whose groups allow reacting; guests and restricted groups get totals only. */
  readonly canReact: boolean;
}

/**
 * One post's reaction bar as its own fragment, tagged `post:{id}:reactions` (ADR 0006). The
 * post body block never carries reaction totals, so a reaction rebuilds only this fragment.
 */
export async function renderReactionBar(input: ReactionBarInput): Promise<string> {
  const rendered = await input.cache.getOrRender({
    tags: [postReactionsTag(input.postId), GLOBAL_CACHE_TAGS.reactions, i18nTag(input.locale)],
    prepare: async () => ({
      key: `reaction-bar:${input.postId}:${input.locale}:${input.canReact ? "member" : "read-only"}`,
      data: {
        reactions: await listReactions(input.sql),
        summary: await readReactionSummary(input.sql, input.postId),
      },
    }),
    render: ({ reactions, summary }) => {
      if (reactions.length === 0) {
        return "";
      }

      const definition = SERVER_ISLANDS.Reactions;

      if (definition === undefined) {
        throw new Error("The Reactions island is not registered");
      }

      const props = {
        postId: input.postId,
        canReact: input.canReact,
        reactions: reactions
          .filter((reaction) => reaction.enabled || (summary[reaction.id] ?? 0) > 0)
          .map((reaction) => ({
            id: reaction.id,
            icon: reaction.icon,
            label: input.translate(reaction.labelKey),
            count: summary[reaction.id] ?? 0,
            enabled: reaction.enabled,
          })),
        labels: {
          bar: input.translate("reaction.bar"),
          pick: input.translate("reaction.pick"),
          remove: input.translate("reaction.remove"),
          whoReacted: input.translate("reaction.whoReacted"),
          close: input.translate("reaction.close"),
          loading: input.translate("reaction.loading"),
          empty: input.translate("reaction.empty"),
          failed: input.translate("reaction.failed"),
          deletedMember: input.translate("member.deletedName"),
        },
      };

      return islandMarkup("Reactions", props, definition.render(props));
    },
  });

  return rendered.html;
}
