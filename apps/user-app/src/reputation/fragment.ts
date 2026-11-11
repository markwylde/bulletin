import type { Locale, Translator } from "@bulletin/i18n";
import { islandMarkup } from "@bulletin/templates";
import { SERVER_ISLANDS } from "@bulletin/ui/islands/server";

export interface ReputationControlInput {
  readonly postId: string;
  readonly receiverId: string;
  readonly canGive: boolean;
  readonly canNegative: boolean;
  readonly locale: Locale;
  readonly translate: Translator;
}

/**
 * The +1/-1 controls for one post. Never cached in the post block: `canGive` depends on the
 * viewer's groups, and the member's own vote arrives through the overlay (ADR 0006). Guests
 * and members without the permission get no controls at all.
 */
export function renderReputationControls(input: ReputationControlInput): string {
  if (!input.canGive) {
    return "";
  }

  const definition = SERVER_ISLANDS.PostReputation;

  if (definition === undefined) {
    throw new Error("The PostReputation island is not registered");
  }

  const props = {
    postId: input.postId,
    receiverId: input.receiverId,
    canGive: true,
    canNegative: input.canNegative,
    locale: input.locale,
    // Only rendered when the viewer's `reputation` flag is on; the island still checks it.
    flags: { reputation: true },
    labels: {
      giveUp: input.translate("reputation.giveUp"),
      giveDown: input.translate("reputation.giveDown"),
      givenUp: input.translate("reputation.givenUp"),
      givenDown: input.translate("reputation.givenDown"),
      failed: input.translate("reputation.failed"),
      dailyLimit: input.translate("reputation.dailyLimit"),
      minPosts: input.translate("reputation.minPosts"),
      negativeNotAllowed: input.translate("reputation.negativeNotAllowed"),
      cannotReceive: input.translate("reputation.cannotReceive"),
      alreadyGiven: input.translate("reputation.alreadyGiven"),
      ownPost: input.translate("reputation.ownPost"),
    },
  };

  return islandMarkup("PostReputation", props, definition.render(props));
}
