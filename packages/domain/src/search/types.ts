/** The search result kinds and sort orders the service supports (ADR 0017). */
export const SEARCH_KINDS = ["topics", "posts"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

export const SEARCH_SORTS = ["relevance", "date"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** The hard cap on matching rows for one search (ADR 0017, design). */
export const SEARCH_RESULT_CAP = 1_000;
/** Rank at most this many recent matches; common terms can otherwise match the whole table. */
export const SEARCH_CANDIDATE_CAP = 10_000;
export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 100;
export const SEARCH_MAX_QUERY_LENGTH = 200;

export interface SearchFilters {
  readonly kind?: SearchKind;
  /** Forums whose descendants are included; null/undefined means every readable forum. */
  readonly forumIds?: readonly string[] | null;
  readonly authorId?: string | null;
  readonly prefixIds?: readonly string[] | null;
  /** Inclusive lower bound on the content's created_at. */
  readonly createdFrom?: Date | null;
  /** Exclusive upper bound on the content's created_at (a whole-day UI passes next midnight). */
  readonly createdTo?: Date | null;
  readonly sort?: SearchSort;
  readonly page?: number;
  readonly perPage?: number;
}

export interface SearchInput extends SearchFilters {
  readonly query: string;
}

export interface TopicSearchHit {
  readonly kind: "topic";
  readonly topicId: string;
  readonly topicTitle: string;
  readonly topicSlug: string;
  readonly forumId: string;
  readonly forumSlug: string;
  readonly forumTitle: string;
  readonly authorId: string | null;
  readonly authorDisplayName: string | null;
  readonly createdAt: Date;
  /** Already HTML-escaped; only the `<mark>` highlight tags are real markup. */
  readonly snippet: string;
  readonly score: number;
}

export interface PostSearchHit {
  readonly kind: "post";
  readonly postId: string;
  readonly topicId: string;
  readonly topicTitle: string;
  readonly topicSlug: string;
  readonly forumId: string;
  readonly forumSlug: string;
  readonly forumTitle: string;
  readonly authorId: string | null;
  readonly authorDisplayName: string | null;
  readonly createdAt: Date;
  readonly position: number;
  /** Already HTML-escaped; only the `<mark>` highlight tags are real markup. */
  readonly snippet: string;
  readonly score: number;
}

export type SearchHit = TopicSearchHit | PostSearchHit;

export interface SearchPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly pageCount: number;
  /** True when the hard cap was reached and older/lower-ranked matches are not counted. */
  readonly capped: boolean;
}
