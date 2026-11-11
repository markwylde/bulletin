import {
  listMemberListGroups,
  listMembers,
  MEMBER_LIST_PAGE_SIZE,
  type MemberListSort,
  memberListDirection,
  memberListPage,
  memberListSort,
} from "@bulletin/domain/member";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { avatarUrl, initialsSvg } from "../avatar.ts";

export interface MemberListPageInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly params: URLSearchParams;
  readonly includeHidden: boolean;
}

export interface MemberListView {
  readonly title: string;
  readonly filters: {
    readonly query: string;
    readonly joinedFrom: string;
    readonly joinedTo: string;
  };
  readonly groups: readonly {
    readonly id: string;
    readonly title: string;
    readonly selected: boolean;
  }[];
  readonly sorts: readonly {
    readonly value: MemberListSort;
    readonly label: string;
    readonly selected: boolean;
  }[];
  readonly members: readonly {
    readonly id: string;
    readonly name: string;
    readonly href: string;
    readonly avatarHtml: ReturnType<typeof safeHtml>;
    readonly groupTitle: string | null;
    readonly groupColour: string | null;
    readonly joinedLabel: string;
    readonly postCountLabel: string;
    readonly reputationLabel: string;
  }[];
  readonly pagination: {
    readonly page: number;
    readonly pageCount: number;
    readonly previousHref: string | null;
    readonly nextHref: string | null;
  };
}

function listHref(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params);
  next.set("page", String(page));

  return `/members?${next.toString()}`;
}

export async function buildMemberListPage(input: MemberListPageInput): Promise<MemberListView> {
  const sort = memberListSort(input.params.get("sort"));
  const direction = memberListDirection(input.params.get("direction"));
  const page = memberListPage(input.params.get("page"));
  const query = input.params.get("q") ?? "";
  const groupId = input.params.get("group");
  const joinedFrom = input.params.get("joinedFrom");
  const joinedTo = input.params.get("joinedTo");
  const [groups, result] = await Promise.all([
    listMemberListGroups(input.sql),
    listMembers(input.sql, {
      query,
      groupId,
      joinedFrom,
      joinedTo,
      sort,
      direction,
      page,
      includeHidden: input.includeHidden,
    }),
  ]);
  const formatter = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium" });
  const number = new Intl.NumberFormat(input.locale);
  const sortLabels: readonly { readonly value: MemberListSort; readonly label: string }[] = [
    { value: "name", label: input.translate("members.sort.name") },
    { value: "joined", label: input.translate("members.sort.joined") },
    { value: "posts", label: input.translate("members.sort.posts") },
    { value: "reputation", label: input.translate("members.sort.reputation") },
  ];
  const pageParams = new URLSearchParams(input.params);
  pageParams.delete("page");

  return {
    title: input.translate("members.title"),
    filters: {
      query,
      joinedFrom: joinedFrom ?? "",
      joinedTo: joinedTo ?? "",
    },
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
      selected: group.id === groupId,
    })),
    sorts: sortLabels.map((option) => ({
      ...option,
      selected: option.value === sort,
    })),
    members: result.members.map((member) => {
      const name = member.displayName;
      const avatar =
        member.avatarHash === null
          ? initialsSvg(member.id, name)
          : `<img class="bl-avatar bl-avatar--image" src="${avatarUrl(
              member.id,
              member.avatarHash,
              "sm",
            )}" alt="" width="40" height="40" loading="lazy">`;

      return {
        id: member.id,
        name,
        href: canonicalUrl("profile", member.id, name),
        avatarHtml: safeHtml(avatar),
        groupTitle: member.groupTitle,
        groupColour: member.groupColour,
        joinedLabel: formatter.format(member.joinedAt),
        postCountLabel: input.translate("member.postCount", { count: member.postCount }),
        reputationLabel: number.format(member.reputation),
      };
    }),
    pagination: {
      page: result.page,
      pageCount: result.pageCount,
      previousHref: result.page > 1 ? listHref(pageParams, result.page - 1) : null,
      nextHref: result.page < result.pageCount ? listHref(pageParams, result.page + 1) : null,
    },
  };
}

export { MEMBER_LIST_PAGE_SIZE };
