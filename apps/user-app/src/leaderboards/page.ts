import {
  guestReadableForumIds,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  readLeaderboard,
} from "@bulletin/domain/leaderboards";
import {
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";

const PERIODS = ["week", "month", "all"] as const satisfies readonly LeaderboardPeriod[];
const METRICS = ["posts", "reactions"] as const satisfies readonly LeaderboardMetric[];

function boardTitle(
  translate: Translator,
  period: LeaderboardPeriod,
  metric: LeaderboardMetric,
): string {
  switch (`${period}.${metric}`) {
    case "week.posts":
      return translate("leaderboards.board.week.posts");
    case "week.reactions":
      return translate("leaderboards.board.week.reactions");
    case "month.posts":
      return translate("leaderboards.board.month.posts");
    case "month.reactions":
      return translate("leaderboards.board.month.reactions");
    case "all.posts":
      return translate("leaderboards.board.all.posts");
    case "all.reactions":
      return translate("leaderboards.board.all.reactions");
    default:
      return "";
  }
}

export interface LeaderboardViewEntry {
  readonly memberId: string;
  readonly rank: number;
  readonly name: string;
  readonly href: string;
  readonly groupColour: string | null;
  readonly value: string;
}

export interface LeaderboardView {
  readonly title: string;
  readonly boards: readonly {
    readonly period: LeaderboardPeriod;
    readonly metric: LeaderboardMetric;
    readonly title: string;
    readonly entries: readonly LeaderboardViewEntry[];
  }[];
  readonly visibilityKey: string;
}

export async function buildLeaderboardsPage(input: {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
}): Promise<LeaderboardView> {
  const tree = await loadForumTree(input.sql);
  const snapshot = await loadPermissionSnapshot(input.sql, GUEST_PRINCIPAL, {
    tree,
    sessionId: null,
  });
  const forums = await guestReadableForumIds(input.sql, tree, snapshot);
  const number = new Intl.NumberFormat(input.locale);
  const boards: Array<{
    readonly period: LeaderboardPeriod;
    readonly metric: LeaderboardMetric;
    readonly title: string;
    readonly entries: readonly LeaderboardViewEntry[];
  }> = [];

  for (const period of PERIODS) {
    for (const metric of METRICS) {
      const entries = await readLeaderboard(input.sql, {
        period,
        metric,
        tree,
        snapshot,
        limit: 10,
      });

      boards.push({
        period,
        metric,
        title: boardTitle(input.translate, period, metric),
        entries: entries.map((entry, index) => ({
          memberId: entry.memberId,
          rank: index + 1,
          name: entry.displayName,
          href: canonicalUrl("profile", entry.memberId, entry.displayName),
          groupColour: null,
          value: number.format(entry.value),
        })),
      });
    }
  }

  return {
    title: input.translate("leaderboards.title"),
    boards,
    visibilityKey: new Bun.CryptoHasher("sha256")
      .update(`leaderboards|${forums.slice().sort().join(",")}`)
      .digest("hex"),
  };
}
