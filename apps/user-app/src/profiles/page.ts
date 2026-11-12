import { applyReplaceWordsToHtml, type ReplaceWords, replaceWordsInText } from "@bulletin/content";
import type { ForumTree } from "@bulletin/domain/permissions";
import {
  CapabilityView,
  can,
  type PermissionSnapshot,
  profileFieldVisibilityClass,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import {
  listMemberBadges,
  localizedText,
  type ProfileField,
  type ProfileFieldValue,
  readMemberFieldValues,
  readProfile,
  readProfileFields,
  readRecentProfilePosts,
} from "@bulletin/domain/profiles";
import { friendsForMember } from "@bulletin/domain/relationships";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { avatarUrl, initialsSvg } from "../avatar.ts";

export interface ProfilePageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly principal: ViewerPrincipal;
  readonly sessionId: string | null;
  readonly tree: ForumTree;
  readonly snapshot: PermissionSnapshot;
  readonly locale: Locale;
  readonly translate: Translator;
  /** How many recent posts to show. */
  readonly recentLimit?: number;
  readonly replaceWords?: ReplaceWords;
}

export interface ProfileFieldView {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly href: string | null;
}

export interface ProfileBadgeView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly imageUrl: string | null;
}

export interface ProfileFriendView {
  readonly id: string;
  readonly name: string;
  readonly href: string;
}

export interface ProfilePostView {
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly forumTitle: string;
  readonly dateLabel: string;
  readonly iso: string;
}

export interface ProfileView {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly initialsHtml: string;
  readonly groupTitle: string | null;
  readonly groupColour: string | null;
  readonly customTitle: string | null;
  readonly rankTitle: string | null;
  readonly rankPips: number;
  readonly rankImageKey: string | null;
  readonly joinedLabel: string;
  readonly postCountLabel: string;
  readonly reputationLabel: string;
  readonly lastActiveLabel: string | null;
  readonly aboutHtml: SafeHtml | null;
  readonly fields: readonly ProfileFieldView[];
  readonly badges: readonly ProfileBadgeView[];
  readonly friends: readonly ProfileFriendView[];
  readonly posts: readonly ProfilePostView[];
}

export interface ProfilePageData {
  readonly title: string;
  readonly breadcrumbs: readonly { readonly label: string; readonly href: string | null }[];
  readonly viewModel: { readonly profile: ProfileView };
  readonly visibilityKey: string;
  readonly hasUnlockGrant: boolean;
}

function dateFormatter(locale: Locale, withTime = false): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" as const } : {}),
  });
}

function numberFormatter(locale: Locale): Intl.NumberFormat {
  return new Intl.NumberFormat(locale);
}

function optionLabel(field: ProfileField, value: string, locale: Locale): string | null {
  const option = field.options.find((entry) => entry.value === value);
  return option === undefined ? null : localizedText(option.labels, locale);
}

/**
 * Formats the exact `YYYY-MM-DD` value stored for a date field. Anything else (legacy or
 * hand-edited data) is not a date: the caller shows the raw value rather than throwing while
 * formatting a different string.
 */
function formattedDateValue(raw: string, locale: Locale): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return null;
  }

  const date = new Date(`${raw}T00:00:00Z`);

  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    return null;
  }

  return dateFormatter(locale).format(date);
}

function fieldView(
  field: ProfileField,
  raw: ProfileFieldValue | undefined,
  locale: Locale,
): ProfileFieldView | null {
  if (raw === undefined) {
    return null;
  }

  const label = localizedText(field.labels, locale);

  switch (field.type) {
    case "number":
      return typeof raw === "number"
        ? { id: field.id, label, value: numberFormatter(locale).format(raw), href: null }
        : null;
    case "date": {
      if (typeof raw !== "string" || raw.trim() === "") {
        return null;
      }

      const formatted = formattedDateValue(raw, locale);

      return {
        id: field.id,
        label,
        value: formatted ?? raw,
        href: null,
      };
    }
    case "url":
      return typeof raw === "string" ? { id: field.id, label, value: raw, href: raw } : null;
    case "select":
      return typeof raw === "string"
        ? (() => {
            const value = optionLabel(field, raw, locale);
            return value === null ? null : { id: field.id, label, value, href: null };
          })()
        : null;
    case "multiselect": {
      if (!Array.isArray(raw)) {
        return null;
      }

      const labels = raw
        .map((entry) => (typeof entry === "string" ? optionLabel(field, entry, locale) : null))
        .filter((entry): entry is string => entry !== null);

      return labels.length === 0
        ? null
        : { id: field.id, label, value: labels.join(", "), href: null };
    }
    case "short_text":
    case "long_text":
      return typeof raw === "string" && raw.trim() !== ""
        ? { id: field.id, label, value: raw, href: null }
        : null;
  }
}

function badgeImageUrl(imageKey: string | null): string | null {
  if (imageKey === null || imageKey.trim() === "") {
    return null;
  }

  return /^(https?:\/\/|\/)/i.test(imageKey) ? imageKey : null;
}

/**
 * Builds the profile page's view model and cache variant (ADR 0005, 0006). The variant
 * combines the viewer's custom-field visibility class, whether they may see hidden members,
 * and the `read` bit of every forum whose posts are candidates for the recent list.
 */
export async function buildProfilePage(input: ProfilePageInput): Promise<ProfilePageData | null> {
  const profile = await readProfile(input.sql, input.memberId);

  if (profile === null || profile.displayName === null) {
    return null;
  }

  const fieldClass = await profileFieldVisibilityClass(input.sql, input.principal);
  const [fields, values, badges, friends, canViewHidden, recent] = await Promise.all([
    readProfileFields(input.sql, fieldClass.ids),
    readMemberFieldValues(input.sql, input.memberId),
    listMemberBadges(input.sql, input.memberId),
    profile.hideFriends ? Promise.resolve([]) : friendsForMember(input.sql, input.memberId),
    can(input.sql, input.principal, "members.view_hidden"),
    readRecentProfilePosts(input.sql, {
      memberId: input.memberId,
      limit: input.recentLimit ?? 5,
      principal: input.principal,
      sessionId: input.sessionId,
      tree: input.tree,
      snapshot: input.snapshot,
    }),
  ]);

  const deps = recent.forums.map((forum) => ({
    forumId: forum.forumId,
    bit: "read" as const,
  }));
  const capabilityView = new CapabilityView({
    ...input.snapshot,
    deps,
    view: "profile",
  });
  const visibilityKey = new Bun.CryptoHasher("sha256")
    .update(
      `profile|fields:${fieldClass.hash}|hidden:${canViewHidden ? 1 : 0}|caps:${capabilityView.visibilityKey()}`,
    )
    .digest("hex");

  const formatter = dateFormatter(input.locale);
  const lastActiveFormatter = dateFormatter(input.locale, true);
  const posts = recent.posts.map((post) => ({
    id: post.id,
    href: canonicalUrl("topic", post.topicId, post.topicSlug),
    title: replaceWordsInText(post.topicTitle, input.replaceWords),
    forumTitle: post.forumTitle,
    dateLabel: formatter.format(post.createdAt),
    iso: post.createdAt.toISOString(),
  }));
  const name = replaceWordsInText(profile.displayName, input.replaceWords);
  const aboutHtml =
    profile.aboutHtml === ""
      ? null
      : safeHtml(await applyReplaceWordsToHtml(profile.aboutHtml, input.replaceWords));

  return {
    title: name,
    breadcrumbs: [{ label: name, href: null }],
    visibilityKey,
    hasUnlockGrant: capabilityView.hasUnlockGrant,
    viewModel: {
      profile: {
        id: profile.id,
        name,
        avatarUrl:
          profile.avatarHash === null ? null : avatarUrl(profile.id, profile.avatarHash, "lg"),
        initialsHtml: initialsSvg(profile.id, name),
        groupTitle: profile.groupTitle,
        groupColour: profile.groupColour,
        customTitle:
          profile.customTitle === null
            ? null
            : replaceWordsInText(profile.customTitle, input.replaceWords),
        rankTitle:
          replaceWordsInText(
            profile.rankTitleLabels === null
              ? ""
              : profile.rankTitleLabels[input.locale]?.trim() ||
                  profile.rankTitleLabels.en?.trim() ||
                  "",
            input.replaceWords,
          ) || null,
        rankPips: profile.rankPips,
        rankImageKey: profile.rankImageKey,
        joinedLabel: formatter.format(profile.joinedAt),
        postCountLabel: numberFormatter(input.locale).format(profile.postCount),
        reputationLabel: numberFormatter(input.locale).format(profile.reputation),
        // A hidden member's last activity is invisible unless the viewer has the permission.
        lastActiveLabel:
          profile.lastActiveAt === null || (profile.hideOnline && !canViewHidden)
            ? null
            : lastActiveFormatter.format(profile.lastActiveAt),
        aboutHtml,
        fields: fields
          .map((field) => {
            const view = fieldView(field, values.get(field.id), input.locale);
            return view === null
              ? null
              : { ...view, value: replaceWordsInText(view.value, input.replaceWords) };
          })
          .filter((field): field is ProfileFieldView => field !== null),
        badges: badges.map((badge) => ({
          id: badge.id,
          label: localizedText(badge.labels, input.locale),
          description: localizedText(badge.descriptionLabels, input.locale),
          imageUrl: badgeImageUrl(badge.imageKey),
        })),
        friends: friends.map((friend) => ({
          id: friend.id,
          name: replaceWordsInText(friend.displayName, input.replaceWords),
          href: canonicalUrl("profile", friend.id, friend.displayName),
        })),
        posts,
      },
    },
  };
}
