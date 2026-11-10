import { GLOBAL_CACHE_TAGS, memberTag, type RenderCache, topicViewsTag } from "@bulletin/cache";
import {
  loadMemberCards,
  type MemberCardRecord,
  readTopicViewCount,
} from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml } from "@bulletin/templates";
import type { SQL } from "bun";

/** The 60 s view-count fragment, independent of the topic's content fragments (ADR 0006). */
export async function renderTopicViewsFragment(
  sql: SQL,
  cache: RenderCache,
  topicId: string,
  locale: Locale,
  translate: Translator,
): Promise<string> {
  const rendered = await cache.getOrRender({
    tags: [topicViewsTag(topicId)],
    prepare: async () => ({
      key: `topic-views:${topicId}:${locale}`,
      data: await readTopicViewCount(sql, topicId),
      ttlMs: 60_000,
    }),
    render: (count) =>
      `<span class="bl-topic__views" data-topic-views="${topicId}">${escapeHtml(
        translate("topic.views", { count: Number(count) }),
      )}</span>`,
  });

  return rendered.html;
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2);

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

function cardHtml(card: MemberCardRecord, translate: Translator): string {
  const name = card.displayName ?? translate("member.deletedName");
  const group = card.groupTitle ?? translate("member.noGroup");
  const profile =
    card.displayName === null ? null : canonicalUrl("profile", card.id, card.displayName);

  return [
    '<span class="bl-author-card" data-member-card="',
    card.id,
    '">',
    '<span class="bl-avatar" aria-hidden="true">',
    escapeHtml(initials(name)),
    "</span>",
    '<span class="bl-author-card__details">',
    profile === null
      ? `<span class="bl-author-card__name">${escapeHtml(name)}</span>`
      : `<a class="bl-author-card__name" href="${escapeHtml(profile)}">${escapeHtml(name)}</a>`,
    `<span class="bl-author-card__group">${escapeHtml(group)}</span>`,
    `<span class="bl-author-card__posts">${escapeHtml(
      translate("member.postCount", { count: card.postCount }),
    )}</span>`,
    "</span>",
    "</span>",
  ].join("");
}

/**
 * Resolves every author reference on a page into its `member:{id}:card` fragment. The card
 * carries no viewer state; a post-count or rank change rebuilds the card, not the post block.
 */
export async function renderMemberCards(
  sql: SQL,
  cache: RenderCache,
  memberIds: readonly string[],
  locale: Locale,
  translate: Translator,
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(memberIds)];
  const cards = await loadMemberCards(sql, unique);
  const rendered = new Map<string, string>();

  for (const id of unique) {
    const card = cards.get(id);

    if (card === undefined) {
      rendered.set(id, "");
      continue;
    }

    const fragment = await cache.getOrRender({
      tags: [memberTag(id), GLOBAL_CACHE_TAGS.ranks],
      prepare: async () => ({ key: `member-card:${id}:${locale}`, data: card }),
      render: (value) => cardHtml(value, translate),
    });

    rendered.set(id, fragment.html);
  }

  return rendered;
}
