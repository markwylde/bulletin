import type { SQL } from "bun";
import type { CapabilityView } from "../permissions/capability.ts";
import {
  countMemberPosts,
  countNewTopics,
  searchMemberPostPage,
  searchNewTopicPage,
} from "./repository.ts";
import {
  type PostSearchHit,
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  type SearchPage,
  type TopicSearchHit,
} from "./types.ts";

export interface ActivityInput {
  readonly page?: number;
  readonly perPage?: number;
}

function pageSizeFor(input: ActivityInput): number {
  return Math.min(
    SEARCH_MAX_PAGE_SIZE,
    input.perPage !== undefined && Number.isSafeInteger(input.perPage) && input.perPage > 0
      ? input.perPage
      : SEARCH_DEFAULT_PAGE_SIZE,
  );
}

function requestedPage(input: ActivityInput): number {
  return input.page !== undefined && Number.isSafeInteger(input.page) && input.page > 0
    ? input.page
    : 1;
}

/** Every post by one member, newest first, limited to what the viewer may read. */
export async function listMemberContent(
  sql: SQL,
  capability: CapabilityView,
  input: ActivityInput & { readonly memberId: string },
): Promise<SearchPage<PostSearchHit>> {
  const pageSize = pageSizeFor(input);
  const total = await countMemberPosts(sql, {
    capability,
    memberId: input.memberId,
    limit: pageSize,
    offset: 0,
  });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage(input), pageCount);
  const items = await searchMemberPostPage(sql, {
    capability,
    memberId: input.memberId,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return { items, page, pageSize, total, pageCount, capped: false };
}

/** Topics with a readable post newer than `since`, most recent activity first. */
export async function listNewContent(
  sql: SQL,
  capability: CapabilityView,
  input: ActivityInput & { readonly since: Date },
): Promise<SearchPage<TopicSearchHit>> {
  const pageSize = pageSizeFor(input);
  const total = await countNewTopics(sql, {
    capability,
    since: input.since,
    limit: pageSize,
    offset: 0,
  });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage(input), pageCount);
  const items = await searchNewTopicPage(sql, {
    capability,
    since: input.since,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return { items, page, pageSize, total, pageCount, capped: false };
}

export interface MemberActivityWindow {
  readonly joinedAt: Date;
  readonly previousVisitAt: Date | null;
}

/** The member's own visit window; the new-content view uses the previous visit. */
export async function readMemberActivityWindow(
  sql: SQL,
  memberId: string,
): Promise<MemberActivityWindow | null> {
  const [row] = (await sql`
    SELECT joined_at, previous_visit_at
    FROM core.members
    WHERE id = ${memberId}
  `) as Array<{ joined_at: Date; previous_visit_at: Date | null }>;

  if (row === undefined) {
    return null;
  }

  return {
    joinedAt: new Date(row.joined_at),
    previousVisitAt: row.previous_visit_at === null ? null : new Date(row.previous_visit_at),
  };
}
