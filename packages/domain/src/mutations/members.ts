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
  tags: (_input, result) => [memberTag(result.memberId)],
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
  tags: (_input, result) => [memberTag(result.memberId)],
};

/**
 * A custom field definition change affects every profile, because the viewer's field
 * visibility class and the rendered fields both change.
 */
export const profileFieldMutation: Mutation<Record<string, never>, unknown> = {
  name: "member.profile_field.update",
  tags: () => [GLOBAL_CACHE_TAGS.profileFields],
};
