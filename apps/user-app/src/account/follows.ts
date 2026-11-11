import { autoFollowTopicsEnabled, listFollows } from "@bulletin/domain/follows";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

export interface FollowsPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly sessionId: string | null;
  readonly locale: Locale;
  readonly translate: Translator;
}

interface FollowRow {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly available: boolean;
  readonly meta: string;
}

export interface FollowsPageData {
  readonly title: string;
  readonly memberId: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly autoFollow: boolean;
    readonly hasTopics: boolean;
    readonly topics: readonly FollowRow[];
    readonly hasForums: boolean;
    readonly forums: readonly FollowRow[];
    readonly hasMembers: boolean;
    readonly members: readonly FollowRow[];
  };
}

/** "My follows": every followed topic, forum and member plus the auto-follow preference. */
export async function buildFollowsPage(input: FollowsPageInput): Promise<FollowsPageData> {
  const [follows, autoFollow] = await Promise.all([
    listFollows(input.sql, input.memberId, input.sessionId),
    autoFollowTopicsEnabled(input.sql, input.memberId),
  ]);
  const title = input.translate("account.follows.title");
  const date = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium" });
  const meta = (followedAt: Date): string =>
    input.translate("account.follows.since", { date: date.format(followedAt) });

  return {
    title,
    memberId: input.memberId,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: title, href: null },
    ],
    viewModel: {
      autoFollow,
      hasTopics: follows.topics.length > 0,
      topics: follows.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        href: topic.available ? canonicalUrl("topic", topic.id, topic.slug) : "",
        available: topic.available,
        meta: meta(topic.followedAt),
      })),
      hasForums: follows.forums.length > 0,
      forums: follows.forums.map((forum) => ({
        id: forum.id,
        title: forum.title,
        href: forum.available ? canonicalUrl("forum", forum.id, forum.slug) : "",
        available: forum.available,
        meta: meta(forum.followedAt),
      })),
      hasMembers: follows.members.length > 0,
      members: follows.members.map((member) => ({
        id: member.id,
        title: member.displayName,
        href: canonicalUrl("profile", member.id, member.displayName),
        available: true,
        meta: meta(member.followedAt),
      })),
    },
  };
}
