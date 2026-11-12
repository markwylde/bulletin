import type { SQL } from "bun";
import type { CapabilityView } from "../permissions/capability.ts";
import { normalizeSearchQuery, parseSearchId, parseSearchIds } from "./input.ts";
import { textSearchConfig } from "./language.ts";
import {
  countPostHits,
  countTopicHits,
  searchClearance,
  searchPostPage,
  searchTopicPage,
} from "./repository.ts";
import {
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_RESULT_CAP,
  type SearchHit,
  type SearchInput,
  type SearchPage,
} from "./types.ts";

export interface SearchScope {
  /** The request's capability accessor: search never reads forum bits on its own (ADR 0005). */
  readonly capability: CapabilityView;
  /** The viewer's board locale; its stemming is ORed with the unstemmed `simple` match. */
  readonly locale: string;
}

function emptyPage(page: number, pageSize: number): SearchPage<SearchHit> {
  return { items: [], page, pageSize, total: 0, pageCount: 1, capped: false };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function validDate(value: Date | null | undefined): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
}

/** Expands each requested forum to itself plus readable descendants (ADR 0017 filters). */
export function expandForumFilter(
  capability: CapabilityView,
  forumIds: readonly string[] | null | undefined,
): readonly string[] | null {
  if (forumIds === null || forumIds === undefined) {
    return null;
  }

  const readable = new Set<string>();

  for (const forumId of forumIds) {
    if (!/^[1-9]\d{0,18}$/.test(forumId)) {
      continue;
    }

    if (capability.read(forumId)) {
      readable.add(forumId);
    }

    for (const node of capability.tree.descendants(forumId)) {
      if (capability.read(node.id)) {
        readable.add(node.id);
      }
    }
  }

  return [...readable].sort((left, right) => Number(left) - Number(right));
}

/**
 * Searches topics or posts with query-time authorisation (ADR 0017).
 *
 * The readable/mod forum arrays come from the same capability accessor every other reader
 * uses, so a password unlock or a revoked permission changes the result immediately.
 */
export async function searchContent(
  sql: SQL,
  scope: SearchScope,
  input: SearchInput,
): Promise<SearchPage<SearchHit>> {
  const query = normalizeSearchQuery(input.query);
  const kind = input.kind ?? "posts";
  const requestedPage = positiveInteger(input.page, 1);
  const pageSize = Math.min(
    SEARCH_MAX_PAGE_SIZE,
    positiveInteger(input.perPage, SEARCH_DEFAULT_PAGE_SIZE),
  );

  if (query === "") {
    return emptyPage(requestedPage, pageSize);
  }

  const { readableForumIds } = searchClearance(scope.capability);

  if (readableForumIds.length === 0) {
    return emptyPage(requestedPage, pageSize);
  }

  const forumIds = expandForumFilter(scope.capability, input.forumIds);

  if (forumIds !== null && forumIds.length === 0) {
    return emptyPage(requestedPage, pageSize);
  }

  const repositoryInput = {
    query,
    queryConfig: textSearchConfig(scope.locale),
    capability: scope.capability,
    forumIds,
    authorId: parseSearchId(input.authorId),
    prefixIds:
      input.prefixIds === null || input.prefixIds === undefined
        ? null
        : parseSearchIds(input.prefixIds),
    createdFrom: validDate(input.createdFrom),
    createdTo: validDate(input.createdTo),
    sort: input.sort ?? "relevance",
  };

  // A supplied but malformed filter must not silently widen the search.
  if (
    input.authorId !== null &&
    input.authorId !== undefined &&
    input.authorId !== "" &&
    repositoryInput.authorId === null
  ) {
    return emptyPage(requestedPage, pageSize);
  }

  if (repositoryInput.prefixIds !== null && repositoryInput.prefixIds.length === 0) {
    return emptyPage(requestedPage, pageSize);
  }

  const total =
    kind === "topics"
      ? await countTopicHits(sql, { ...repositoryInput, limit: pageSize, offset: 0 })
      : await countPostHits(sql, { ...repositoryInput, limit: pageSize, offset: 0 });

  if (total === 0) {
    return emptyPage(requestedPage, pageSize);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const offset = (page - 1) * pageSize;
  const limit = Math.min(pageSize, SEARCH_RESULT_CAP - offset);

  if (limit <= 0) {
    return { items: [], page, pageSize, total, pageCount, capped: total >= SEARCH_RESULT_CAP };
  }

  const repositoryPage = { ...repositoryInput, limit, offset };
  const items =
    kind === "topics"
      ? await searchTopicPage(sql, repositoryPage)
      : await searchPostPage(sql, repositoryPage);

  return {
    items,
    page,
    pageSize,
    total,
    pageCount,
    capped: total >= SEARCH_RESULT_CAP,
  };
}
