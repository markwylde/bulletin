import type { Locale } from "@bulletin/i18n";

export const PROFILE_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "date",
  "url",
  "select",
  "multiselect",
] as const;

export type ProfileFieldType = (typeof PROFILE_FIELD_TYPES)[number];

export function isProfileFieldType(value: unknown): value is ProfileFieldType {
  return typeof value === "string" && (PROFILE_FIELD_TYPES as readonly string[]).includes(value);
}

/** Staff-created labels are data, stored for every shipped locale (ADR 0013). */
export type LocalizedText = Readonly<Record<Locale, string>>;

export interface ProfileFieldOption {
  readonly value: string;
  readonly labels: LocalizedText;
}

export interface ProfileField {
  readonly id: string;
  readonly type: ProfileFieldType;
  readonly required: boolean;
  readonly labels: LocalizedText;
  readonly options: readonly ProfileFieldOption[];
  readonly position: number;
}

export interface ProfileFieldGroupRule {
  readonly groupId: string;
  readonly groupTitle: string;
  readonly canView: boolean;
  readonly canEdit: boolean;
}

export interface ProfileFieldAdmin extends ProfileField {
  readonly groups: readonly ProfileFieldGroupRule[];
}

/** The JSONB payload of `core.member_field_values.value`. */
export type ProfileFieldValue = string | number | readonly string[];

export interface ProfileRecord {
  readonly id: string;
  readonly displayName: string | null;
  readonly avatarHash: string | null;
  readonly joinedAt: Date;
  readonly lastActiveAt: Date | null;
  readonly postCount: number;
  readonly reputation: number;
  readonly aboutMd: string;
  readonly aboutHtml: string;
  readonly hideOnline: boolean;
  readonly hideFromMemberList: boolean;
  readonly hideSignatures: boolean;
  readonly hideFriends: boolean;
  readonly signatureMd: string;
  readonly signatureHtml: string;
  readonly groupTitle: string | null;
  readonly groupColour: string | null;
}

export interface SignatureLimits {
  readonly maxChars: number;
  readonly maxLines: number;
  readonly maxImages: number;
  readonly maxLinks: number;
}

export interface MemberBadge {
  readonly id: string;
  readonly key: string;
  readonly labels: LocalizedText;
  readonly descriptionLabels: Readonly<Partial<Record<Locale, string>>>;
  readonly imageKey: string | null;
  readonly position: number;
}

export interface RecentProfilePost {
  readonly id: string;
  readonly topicId: string;
  readonly topicTitle: string;
  readonly topicSlug: string;
  readonly forumId: string;
  readonly forumTitle: string;
  readonly createdAt: Date;
}

/** A field's translated label, falling back to English for incomplete runtime data. */
export function localizedText(
  labels: Readonly<Partial<Record<Locale, string>>>,
  locale: Locale,
): string {
  return labels[locale]?.trim() || labels.en?.trim() || "";
}

export function emptyProfileFieldValue(value: ProfileFieldValue | null | undefined): boolean {
  if (value === null || value === undefined) {
    return true;
  }

  if (typeof value === "string") {
    return value.trim() === "";
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return false;
}
