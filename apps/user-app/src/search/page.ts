import { listForumPrefixes, listVisibleForums } from "@bulletin/domain/forums";
import { readMember } from "@bulletin/domain/member";
import { type CapabilityView, can, type ViewerPrincipal } from "@bulletin/domain/permissions";
import {
  listMemberContent,
  listNewContent,
  normalizeSearchQuery,
  parseSearchDate,
  parseSearchId,
  parseSearchKind,
  parseSearchPage,
  parseSearchSort,
  readMemberActivityWindow,
  type SearchHit,
  type SearchSort,
  searchContent,
  searchMembers,
} from "@bulletin/domain/search";
import { canonicalUrl, slugify } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";

export interface SearchResultView {
  readonly key: string;
  readonly href: string;
  readonly title: string;
  readonly kindLabel: string;
  readonly forumTitle: string;
  readonly forumHref: string;
  readonly authorName: string | null;
  readonly authorHref: string | null;
  readonly dateLabel: string;
  readonly snippet: SafeHtml;
}

export interface SearchOption {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export type SearchUiKind = "topics" | "posts" | "members";

export interface SearchMemberView {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly groupTitle: string | null;
  readonly groupColour: string | null;
}

export interface SearchView {
  readonly mode: "search" | "member" | "new";
  readonly title: string;
  readonly heading: string;
  readonly intro: string | null;
  readonly action: string;
  readonly showFilters: boolean;
  readonly query: {
    readonly value: string;
    readonly kind: SearchUiKind;
    readonly sort: SearchSort;
    readonly forumId: string;
    readonly prefixId: string;
    readonly authorId: string;
    readonly authorName: string | null;
    readonly createdFrom: string;
    readonly createdTo: string;
  };
  readonly kinds: readonly SearchOption[];
  readonly sorts: readonly SearchOption[];
  readonly forums: readonly SearchOption[];
  readonly prefixes: readonly SearchOption[];
  readonly results: readonly SearchResultView[];
  readonly members: readonly SearchMemberView[];
  readonly floodWaitSeconds: number | null;
  readonly pagination: {
    readonly page: number;
    readonly pageCount: number;
    readonly previousHref: string | null;
    readonly nextHref: string | null;
  };
  readonly noResults: { readonly title: string; readonly body: string };
  readonly member: { readonly name: string; readonly href: string } | null;
  readonly sinceLabel: string | null;
}

export interface SearchPageInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly principal: ViewerPrincipal;
  readonly capability: CapabilityView;
  readonly params: URLSearchParams;
  readonly perPage?: number;
  /** Set by the route when the group's search interval refused this request. */
  readonly floodWaitSeconds?: number | null;
}

function resultViews(
  hits: readonly SearchHit[],
  locale: Locale,
  translate: Translator,
): readonly SearchResultView[] {
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return hits.map((hit) => ({
    key: `${hit.kind}:${hit.kind === "post" ? hit.postId : hit.topicId}`,
    href:
      hit.kind === "post"
        ? canonicalUrl("topic", hit.topicId, hit.topicSlug, { postId: hit.postId })
        : canonicalUrl("topic", hit.topicId, hit.topicSlug),
    title: hit.topicTitle,
    kindLabel: hit.kind === "post" ? translate("search.kind.post") : translate("search.kind.topic"),
    forumTitle: hit.forumTitle,
    forumHref: canonicalUrl("forum", hit.forumId, hit.forumTitle),
    authorName: hit.authorDisplayName,
    authorHref:
      hit.authorId === null || hit.authorDisplayName === null
        ? null
        : canonicalUrl("profile", hit.authorId, hit.authorDisplayName),
    dateLabel: formatter.format(hit.createdAt),
    snippet: safeHtml(hit.snippet),
  }));
}

function pageHref(base: string, page: number): string {
  if (page <= 1) {
    return base;
  }

  return `${base}${base.includes("?") ? "&" : "?"}page=${page}`;
}

function pagination(base: string, page: number, pageCount: number) {
  return {
    page,
    pageCount,
    previousHref: page > 1 ? pageHref(base, page - 1) : null,
    nextHref: page < pageCount ? pageHref(base, page + 1) : null,
  };
}

async function visibleForumOptions(
  sql: SQL,
  capability: CapabilityView,
  selectedId: string,
): Promise<readonly SearchOption[]> {
  const forums = await listVisibleForums(sql, capability);

  return forums
    .filter((forum) => forum.type !== "redirect" && capability.read(forum.id))
    .map((forum) => ({
      value: forum.id,
      label: forum.title,
      selected: forum.id === selectedId,
    }));
}

async function prefixOptions(
  sql: SQL,
  principal: ViewerPrincipal,
  locale: Locale,
  forumId: string,
  selectedId: string,
): Promise<readonly SearchOption[]> {
  if (forumId === "") {
    return [];
  }

  const prefixes = await listForumPrefixes(sql, forumId, locale);
  const options: SearchOption[] = [];

  for (const prefix of prefixes) {
    if (await can(sql, principal, "view_prefix", { prefixId: prefix.id })) {
      options.push({
        value: prefix.id,
        label: prefix.label,
        selected: prefix.id === selectedId,
      });
    }
  }

  return options;
}

export async function buildSearchPage(input: SearchPageInput): Promise<SearchView> {
  const rawQuery = input.params.get("q") ?? "";
  const query = normalizeSearchQuery(rawQuery);
  const kind: SearchUiKind =
    input.params.get("kind") === "members" ? "members" : parseSearchKind(input.params.get("kind"));
  const sort = parseSearchSort(input.params.get("sort"));
  const forumId = parseSearchId(input.params.get("forum")) ?? "";
  const prefixId = parseSearchId(input.params.get("prefix")) ?? "";
  const authorId = parseSearchId(input.params.get("author")) ?? "";
  const createdFrom = parseSearchDate(input.params.get("from"));
  const createdToInput = parseSearchDate(input.params.get("to"));
  // The input is a whole day; the query uses an exclusive next-midnight boundary.
  const createdTo =
    createdToInput === null ? null : new Date(createdToInput.getTime() + 86_400_000);
  const author = authorId === "" ? null : await readMember(input.sql, authorId);
  let result: {
    readonly items: readonly SearchHit[];
    readonly page: number;
    readonly pageCount: number;
  } = { items: [], page: 1, pageCount: 1 };
  let members: readonly SearchMemberView[] = [];

  if (input.floodWaitSeconds === null || input.floodWaitSeconds === undefined) {
    if (kind === "members") {
      const found = await searchMembers(input.sql, input.principal, {
        query,
        limit: input.perPage ?? 20,
      });
      members = found.map((member) => ({
        id: member.id,
        name: member.displayName,
        href: canonicalUrl("profile", member.id, member.displayName),
        groupTitle: member.groupTitle,
        groupColour: member.groupColour,
      }));
    } else {
      result = await searchContent(
        input.sql,
        { capability: input.capability, locale: input.locale },
        {
          query,
          kind,
          sort,
          page: parseSearchPage(input.params.get("page")),
          perPage: input.perPage ?? 20,
          forumIds: forumId === "" ? null : [forumId],
          prefixIds: prefixId === "" ? null : [prefixId],
          authorId: authorId === "" ? null : authorId,
          createdFrom,
          createdTo,
        },
      );
    }
  }

  const [forums, prefixes] = await Promise.all([
    visibleForumOptions(input.sql, input.capability, forumId),
    prefixOptions(input.sql, input.principal, input.locale, forumId, prefixId),
  ]);
  const pageParams = new URLSearchParams(input.params);
  pageParams.delete("page");
  const base = pageParams.toString() === "" ? "/search" : `/search?${pageParams.toString()}`;

  return {
    mode: "search",
    title: input.translate("search.title"),
    heading: input.translate("search.title"),
    intro: input.translate("search.intro"),
    action: "/search",
    showFilters: true,
    query: {
      value: rawQuery,
      kind,
      sort,
      forumId,
      prefixId,
      authorId,
      authorName: author?.displayName ?? null,
      createdFrom: createdFrom === null ? "" : (input.params.get("from") ?? ""),
      createdTo: createdToInput === null ? "" : (input.params.get("to") ?? ""),
    },
    kinds: [
      {
        value: "posts",
        label: input.translate("search.kind.posts"),
        selected: kind === "posts",
      },
      {
        value: "topics",
        label: input.translate("search.kind.topics"),
        selected: kind === "topics",
      },
      {
        value: "members",
        label: input.translate("search.kind.members"),
        selected: kind === "members",
      },
    ],
    sorts: [
      {
        value: "relevance",
        label: input.translate("search.sort.relevance"),
        selected: sort === "relevance",
      },
      { value: "date", label: input.translate("search.sort.date"), selected: sort === "date" },
    ],
    forums,
    prefixes,
    results: resultViews(result.items, input.locale, input.translate),
    members,
    floodWaitSeconds: input.floodWaitSeconds ?? null,
    pagination: pagination(base, result.page, result.pageCount),
    noResults: {
      title: input.translate("search.empty.title"),
      body: input.translate("search.empty.body"),
    },
    member: null,
    sinceLabel: null,
  };
}

export interface MemberContentPageInput extends SearchPageInput {
  readonly ref: string;
}

export interface SearchMemberRef {
  readonly id: string;
  readonly slug: string | null;
}

export function parseSearchMemberRef(ref: string): SearchMemberRef | null {
  const match = /^([1-9]\d{0,18})(?:-([^/]*))?$/.exec(ref);

  if (match === null) {
    return null;
  }

  return { id: match[1] ?? "", slug: match[2] === undefined || match[2] === "" ? null : match[2] };
}

export function memberContentPath(id: string, name: string): string {
  return `/search/member/${id}-${slugify(name)}`;
}

export async function buildMemberContentPage(
  input: MemberContentPageInput,
): Promise<SearchView | null> {
  const parsed = parseSearchMemberRef(input.ref);

  if (parsed === null) {
    return null;
  }

  const member = await readMember(input.sql, parsed.id);

  if (member === null) {
    return null;
  }

  const name = member.displayName ?? input.translate("search.member.unnamed");
  const result = await listMemberContent(input.sql, input.capability, {
    memberId: parsed.id,
    page: parseSearchPage(input.params.get("page")),
    perPage: input.perPage ?? 20,
  });
  const base = memberContentPath(parsed.id, name);

  return {
    mode: "member",
    title: input.translate("search.member.title", { name }),
    heading: input.translate("search.member.heading", { name }),
    intro: input.translate("search.member.intro"),
    action: base,
    showFilters: false,
    query: {
      value: "",
      kind: "posts",
      sort: "date",
      forumId: "",
      prefixId: "",
      authorId: parsed.id,
      authorName: member.displayName,
      createdFrom: "",
      createdTo: "",
    },
    kinds: [],
    sorts: [],
    forums: [],
    prefixes: [],
    results: resultViews(result.items, input.locale, input.translate),
    members: [],
    floodWaitSeconds: null,
    pagination: pagination(base, result.page, result.pageCount),
    noResults: {
      title: input.translate("search.member.empty.title"),
      body: input.translate("search.member.empty.body"),
    },
    member: {
      name,
      href: canonicalUrl("profile", parsed.id, name),
    },
    sinceLabel: null,
  };
}

export interface NewContentPageInput extends SearchPageInput {
  readonly memberId: string;
}

export async function buildNewContentPage(input: NewContentPageInput): Promise<SearchView | null> {
  const window = await readMemberActivityWindow(input.sql, input.memberId);

  if (window === null) {
    return null;
  }

  const since = window.previousVisitAt ?? window.joinedAt;
  const result = await listNewContent(input.sql, input.capability, {
    since,
    page: parseSearchPage(input.params.get("page")),
    perPage: input.perPage ?? 20,
  });
  const formatter = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium" });

  return {
    mode: "new",
    title: input.translate("search.new.title"),
    heading: input.translate("search.new.heading"),
    intro: input.translate("search.new.intro", { date: formatter.format(since) }),
    action: "/search/new",
    showFilters: false,
    query: {
      value: "",
      kind: "topics",
      sort: "date",
      forumId: "",
      prefixId: "",
      authorId: "",
      authorName: null,
      createdFrom: "",
      createdTo: "",
    },
    kinds: [],
    sorts: [],
    forums: [],
    prefixes: [],
    results: resultViews(result.items, input.locale, input.translate),
    members: [],
    floodWaitSeconds: null,
    pagination: pagination("/search/new", result.page, result.pageCount),
    noResults: {
      title: input.translate("search.new.empty.title"),
      body: input.translate("search.new.empty.body"),
    },
    member: null,
    sinceLabel: formatter.format(since),
  };
}
