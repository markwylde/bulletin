import {
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_KINDS,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_SORTS,
  type SearchKind,
  type SearchSort,
} from "./types.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Search text is free-form; only its length and NULs are normalised (the syntax is Postgres'). */
export function normalizeSearchQuery(value: string | null | undefined): string {
  return (value ?? "").replaceAll("\u0000", " ").trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
}

export function parseSearchKind(value: string | null | undefined): SearchKind {
  return value !== null &&
    value !== undefined &&
    (SEARCH_KINDS as readonly string[]).includes(value)
    ? (value as SearchKind)
    : "posts";
}

export function parseSearchSort(value: string | null | undefined): SearchSort {
  return value !== null &&
    value !== undefined &&
    (SEARCH_SORTS as readonly string[]).includes(value)
    ? (value as SearchSort)
    : "relevance";
}

export function parseSearchPage(value: string | null | undefined): number {
  return value !== null && value !== undefined && /^\d{1,4}$/.test(value)
    ? Math.max(1, Number(value))
    : 1;
}

export function parseSearchPageSize(value: string | null | undefined): number {
  if (value === null || value === undefined || !/^\d{1,3}$/.test(value)) {
    return SEARCH_DEFAULT_PAGE_SIZE;
  }

  return Math.min(SEARCH_MAX_PAGE_SIZE, Math.max(1, Number(value)));
}

/**
 * True when the query is plain words only, with no phrase quotes, `-exclusion` or `OR`.
 * The trigram title fallback is only safe for plain queries: it cannot see the parsed
 * syntax, so it could otherwise return a topic the full-text query excluded (ADR 0017).
 */
export function isSimpleSearchQuery(query: string): boolean {
  return !/["()&|!]|(^|[^\p{L}\p{N}_])-|(^|[^\p{L}\p{N}_])or([^\p{L}\p{N}_]|$)/iu.test(query);
}

/** A `YYYY-MM-DD` query value as a UTC date, or null when absent/invalid. */
export function parseSearchDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || !DATE.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

const ID = /^[1-9]\d{0,18}$/;

export function parseSearchIds(value: readonly (string | null | undefined)[]): readonly string[] {
  const ids = new Set<string>();

  for (const item of value) {
    if (item !== null && item !== undefined && ID.test(item)) {
      ids.add(item);
    }
  }

  return [...ids];
}

export function parseSearchId(value: string | null | undefined): string | null {
  return value !== null && value !== undefined && ID.test(value) ? value : null;
}
