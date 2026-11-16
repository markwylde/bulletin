import { GLOBAL_CACHE_TAGS, memberTag, type RenderCache, topicViewsTag } from "@bulletin/cache";
import type { ReplaceWords } from "@bulletin/content";
import { type ReputationLabel, reputationLabelFor } from "@bulletin/domain/reputation";
import {
  loadMemberCards,
  type MemberCardRecord,
  readTopicViewCount,
} from "@bulletin/domain/topics";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { avatarUrl, initialsSvg } from "../avatar.ts";

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

/** The board's reputation display settings, captured in the card fragment's cache key. */
export interface ReputationDisplay {
  readonly display: boolean;
  readonly scale: readonly ReputationLabel[];
}

function reputationHtml(
  card: MemberCardRecord,
  translate: Translator,
  reputation: ReputationDisplay | null,
): string {
  if (reputation === null || !reputation.display) {
    return "";
  }

  // Read like "151 posts": the score with its unit, plus the level word only when it says
  // something beyond the neutral default.
  const level = reputationLabelFor(reputation.scale, card.reputation);

  return [
    '<span class="bl-author-card__reputation">',
    `<span data-reputation-count="${card.id}">${card.reputation}</span> `,
    escapeHtml(translate("member.reputationUnit")),
    level === "reputation.label.neutral"
      ? ""
      : ` <span aria-hidden="true">·</span> <span data-reputation-label="${card.id}">${escapeHtml(
          translate(level),
        )}</span>`,
    "</span>",
  ].join("");
}

function cardHtml(
  card: MemberCardRecord,
  translate: Translator,
  avatarEnabled: boolean,
  reputation: ReputationDisplay | null,
  badgesEnabled = true,
): string {
  const name = card.displayName ?? translate("member.deletedName");
  const group = card.groupTitle ?? translate("member.noGroup");
  const profile =
    card.displayName === null ? null : canonicalUrl("profile", card.id, card.displayName);

  const avatar =
    card.avatarHash === null || !avatarEnabled
      ? initialsSvg(card.id, name)
      : `<img class="bl-avatar bl-avatar--image" src="${escapeHtml(
          avatarUrl(card.id, card.avatarHash, "sm"),
        )}" alt="" width="40" height="40" loading="lazy" data-member-avatar>`;
  const title = card.customTitle ?? card.rankTitle;
  const pips =
    card.rankImageKey !== null
      ? `<img class="bl-author-card__rank-image" src="${escapeHtml(card.rankImageKey)}" alt="" width="20" height="20" loading="lazy" data-member-rank-image>`
      : card.rankPips > 0
        ? `<span class="bl-author-card__pips" data-member-pips="${card.rankPips}" aria-hidden="true">${"●".repeat(
            Math.min(card.rankPips, 20),
          )}</span>`
        : "";
  const badges = !badgesEnabled
    ? ""
    : card.featuredBadges
        .map((badge) =>
          badge.imageKey === null
            ? `<span class="bl-author-card__badge" data-member-badge>${escapeHtml(badge.label)}</span>`
            : `<img class="bl-author-card__badge" src="${escapeHtml(badge.imageKey)}" alt="${escapeHtml(
                badge.label,
              )}" width="16" height="16" loading="lazy" data-member-badge>`,
        )
        .join("");

  return [
    '<span class="bl-author-card" data-member-card="',
    card.id,
    '">',
    avatar,
    '<span class="bl-author-card__details">',
    profile === null
      ? `<span class="bl-author-card__name">${escapeHtml(name)}</span>`
      : `<a class="bl-author-card__name" href="${escapeHtml(profile)}">${escapeHtml(name)}</a>`,
    `<span class="bl-author-card__group">${escapeHtml(group)}</span>`,
    title === null && pips === ""
      ? ""
      : `<span class="bl-author-card__rank">${
          title === null ? "" : `<span class="bl-author-card__title">${escapeHtml(title)}</span>`
        }${pips}</span>`,
    `<span class="bl-author-card__posts">${escapeHtml(
      translate("member.postCount", { count: card.postCount }),
    )}</span>`,
    reputationHtml(card, translate, reputation),
    badges === "" ? "" : `<span class="bl-author-card__badges">${badges}</span>`,
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
  avatarEnabled = true,
  reputation: ReputationDisplay | null = null,
  badgesEnabled = true,
  replaceWords?: ReplaceWords,
): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(memberIds)];
  const cards = await loadMemberCards(sql, unique, locale, replaceWords);
  const rendered = new Map<string, string>();

  for (const id of unique) {
    const card = cards.get(id);

    if (card === undefined) {
      rendered.set(id, "");
      continue;
    }

    const fragment = await cache.getOrRender({
      tags: [
        memberTag(id),
        GLOBAL_CACHE_TAGS.ranks,
        GLOBAL_CACHE_TAGS.badges,
        GLOBAL_CACHE_TAGS.flags,
        GLOBAL_CACHE_TAGS.board,
        GLOBAL_CACHE_TAGS.filters,
      ],
      prepare: async () => ({
        key: `member-card:${id}:${locale}:avatar=${avatarEnabled ? "on" : "off"}:badges=${
          badgesEnabled ? "on" : "off"
        }:rep=${
          reputation === null || !reputation.display ? "off" : JSON.stringify(reputation.scale)
        }`,
        data: card,
      }),
      render: (value) => cardHtml(value, translate, avatarEnabled, reputation, badgesEnabled),
    });

    rendered.set(id, fragment.html);
  }

  return rendered;
}
