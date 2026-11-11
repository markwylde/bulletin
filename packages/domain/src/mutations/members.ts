import { GLOBAL_CACHE_TAGS, memberTag } from "@bulletin/cache";
import type { Mutation } from "./index.ts";

export interface MemberAvatarSummary {
  readonly memberId: string;
}

/**
 * An avatar change invalidates the `member:{id}` card fragment only. Post blocks depend on
 * post/topic tags, so they stay cached (ADR 0006, 0019).
 */
export const memberAvatarMutation: Mutation<{ readonly memberId: string }, MemberAvatarSummary> = {
  name: "member.avatar.update",
  tags: (_input, result) => [memberTag(result.memberId), GLOBAL_CACHE_TAGS.directory],
};

/**
 * A profile edit rebuilds that member's profile page and author card only. Post blocks do not
 * carry the about text or custom fields, so they stay cached (ADR 0006).
 */
export const memberProfileMutation: Mutation<
  { readonly memberId: string },
  { readonly memberId: string }
> = {
  name: "member.profile.update",
  // Privacy options change the member list and who's online, not just the profile page.
  tags: (_input, result) => [
    memberTag(result.memberId),
    GLOBAL_CACHE_TAGS.directory,
    GLOBAL_CACHE_TAGS.online,
  ],
};

/**
 * A custom field definition change affects every profile, because the viewer's field
 * visibility class and the rendered fields both change.
 */
export const profileFieldMutation: Mutation<Record<string, never>, unknown> = {
  name: "member.profile_field.update",
  tags: () => [GLOBAL_CACHE_TAGS.profileFields],
};

/** A rank edit rebuilds every author card but leaves post blocks cached (task 5.3). */
export const rankMutation: Mutation<Record<string, never>, unknown> = {
  name: "member.rank.update",
  tags: () => [GLOBAL_CACHE_TAGS.ranks],
};

/** A badge definition, award or featured change rebuilds member cards and profiles. */
export const badgeMutation: Mutation<{ readonly memberIds?: readonly string[] }, unknown> = {
  name: "member.badge.update",
  tags: (input) => [GLOBAL_CACHE_TAGS.badges, ...(input.memberIds ?? []).map(memberTag)],
};

/** Accepting or removing a friendship changes both members' profile friend lists. */
export const friendshipMutation: Mutation<
  { readonly memberIds: readonly string[] },
  { readonly memberIds: readonly string[] }
> = {
  name: "member.friendship.update",
  tags: (_input, result) => result.memberIds.map(memberTag),
};
