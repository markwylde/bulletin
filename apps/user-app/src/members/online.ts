import type { ForumTree, PermissionSnapshot, ViewerPrincipal } from "@bulletin/domain/permissions";
import { readOnlineOverview } from "@bulletin/domain/presence";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";

export interface OnlinePageView {
  readonly title: string;
  readonly online: {
    readonly memberCount: string;
    readonly guestCount: string;
    readonly members: readonly {
      readonly id: string;
      readonly name: string;
      readonly href: string;
      readonly groupTitle: string | null;
      readonly groupColour: string | null;
      readonly location: string;
    }[];
  };
}

export async function buildOnlinePage(input: {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
  readonly canViewHidden: boolean;
}): Promise<OnlinePageView> {
  const overview = await readOnlineOverview(input.sql, {
    principal: input.principal,
    sessionId: input.sessionId,
    tree: input.tree,
    snapshot: input.snapshot,
    canViewHidden: input.canViewHidden,
    withLocations: true,
  });

  return {
    title: input.translate("online.title"),
    online: {
      memberCount: input.translate("index.online.members", { count: overview.memberCount }),
      guestCount: input.translate("index.online.guests", { count: overview.guestCount }),
      members: overview.members.map((member) => ({
        id: member.id,
        name: member.displayName,
        href: canonicalUrl("profile", member.id, member.displayName),
        groupTitle: member.groupTitle,
        groupColour: member.groupColour,
        location: member.location ?? input.translate("online.viewingBoard"),
      })),
    },
  };
}
