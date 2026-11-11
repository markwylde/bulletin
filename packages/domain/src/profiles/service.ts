import { ContentError, renderContent, renderSnapshot, saveContent } from "@bulletin/content";
import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { readMemberBadges } from "../badges/repository.ts";
import { runMutation } from "../mutations/index.ts";
import { memberProfileMutation, profileFieldMutation } from "../mutations/members.ts";
import { can } from "../permissions/can.ts";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import {
  deleteProfileField,
  type ProfileFieldWrite,
  replaceFeaturedBadges,
  replaceFieldValues,
  updateCustomTitle,
  updateHideFriends,
  updateHideSignatures,
  updateMemberSignature,
  updateProfileRow,
  writeProfileField,
} from "./repository.ts";
import {
  emptyProfileFieldValue,
  isProfileFieldType,
  type LocalizedText,
  type ProfileField,
  type ProfileFieldOption,
  type ProfileFieldValue,
  type SignatureLimits,
} from "./types.ts";

const LOCALES: readonly Locale[] = ["en", "es", "fr"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localizedText(value: unknown): LocalizedText | null {
  if (!isRecord(value)) {
    return null;
  }

  const labels: Partial<Record<Locale, string>> = {};

  for (const locale of LOCALES) {
    const text = value[locale];

    if (typeof text !== "string" || text.trim() === "") {
      return null;
    }

    labels[locale] = text.trim();
  }

  return labels as LocalizedText;
}

function option(value: unknown): ProfileFieldOption | null {
  if (!isRecord(value) || typeof value.value !== "string" || value.value.trim() === "") {
    return null;
  }

  const labels = localizedText(value.labels);

  return labels === null ? null : { value: value.value.trim(), labels };
}

function integer(value: unknown, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Parses one staff field-manager payload; null means a user-visible `invalid` response. */
export function parseProfileFieldInput(value: unknown): ProfileFieldWrite | null {
  if (!isRecord(value) || !isProfileFieldType(value.type)) {
    return null;
  }

  const labels = localizedText(value.labels);
  const required = value.required === true;
  const position = integer(value.position, 0);

  if (labels === null || position === null) {
    return null;
  }

  const rawOptions = value.options ?? [];
  const options: ProfileFieldOption[] = [];

  if (!Array.isArray(rawOptions)) {
    return null;
  }

  for (const raw of rawOptions) {
    const parsed = option(raw);

    if (parsed === null || options.some((entry) => entry.value === parsed.value)) {
      return null;
    }

    options.push(parsed);
  }

  const usesOptions = value.type === "select" || value.type === "multiselect";

  if (usesOptions ? options.length === 0 : options.length > 0) {
    return null;
  }

  const groups: ProfileFieldWrite["groups"][number][] = [];

  for (const raw of Array.isArray(value.groups) ? value.groups : []) {
    if (
      !isRecord(raw) ||
      typeof raw.groupId !== "string" ||
      !/^\d+$/.test(raw.groupId) ||
      groups.some((group) => group.groupId === raw.groupId)
    ) {
      return null;
    }

    const canView = raw.canView === true;
    const canEdit = raw.canEdit === true;

    if (canEdit && !canView) {
      return null;
    }

    groups.push({ groupId: raw.groupId, canView, canEdit });
  }

  const id =
    typeof value.id === "string" && /^\d+$/.test(value.id)
      ? value.id
      : value.id === undefined
        ? null
        : undefined;

  if (id === undefined) {
    return null;
  }

  return {
    id,
    type: value.type,
    required,
    labels,
    options,
    position,
    groups,
  };
}

export type ProfileFieldMutationResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found" | "unknown_group" | "incompatible_values";
    };

/**
 * Stored values must survive an edit to their field's definition. A type change from text to
 * date (or a removed select option) would otherwise leave values no renderer can format.
 */
async function storedValuesFitField(sql: SQL, input: ProfileFieldWrite): Promise<boolean> {
  if (input.id === null) {
    return true;
  }

  const rows = (await sql`
    SELECT value FROM core.member_field_values WHERE field_id = ${input.id}
  `) as Array<{ value: unknown }>;

  if (rows.length === 0) {
    return true;
  }

  const field: ProfileField = {
    id: input.id,
    type: input.type,
    required: input.required,
    labels: input.labels,
    options: input.options,
    position: input.position,
  };

  return rows.every((row) => normalizeValue(field, row.value).ok);
}

/** Saves one definition and invalidates every cached profile (the field class may change). */
export async function saveProfileField(
  sql: SQL,
  input: ProfileFieldWrite,
): Promise<ProfileFieldMutationResult> {
  if (!(await storedValuesFitField(sql, input))) {
    return { ok: false, code: "incompatible_values" };
  }

  if (input.groups.length > 0) {
    const ids = input.groups.map((group) => group.groupId);
    const [known] = (await sql`
      SELECT count(*)::int AS count
      FROM core.groups
      WHERE id = ANY(${`{${ids.join(",")}}`}::bigint[])
    `) as Array<{ count: number }>;

    if ((known?.count ?? 0) !== new Set(ids).size) {
      return { ok: false, code: "unknown_group" };
    }
  }

  const id = await runMutation({
    sql,
    mutation: profileFieldMutation,
    input: {},
    apply: (tx) => writeProfileField(tx, input),
  });

  return { ok: true, id };
}

export async function removeProfileField(
  sql: SQL,
  fieldId: string,
): Promise<ProfileFieldMutationResult> {
  if (!/^\d+$/.test(fieldId)) {
    return { ok: false, code: "not_found" };
  }

  const removed = await runMutation({
    sql,
    mutation: profileFieldMutation,
    input: {},
    apply: (tx) => deleteProfileField(tx, fieldId),
  });

  return removed ? { ok: true, id: fieldId } : { ok: false, code: "not_found" };
}

type NormalizedValue =
  | { readonly ok: true; readonly value: ProfileFieldValue | null }
  | { readonly ok: false };

function normalizeValue(field: ProfileField, raw: unknown): NormalizedValue {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: null };
  }

  switch (field.type) {
    case "short_text": {
      if (typeof raw !== "string") {
        return { ok: false };
      }

      const text = raw.trim();

      return text.length === 0
        ? { ok: true, value: null }
        : text.length <= 200
          ? { ok: true, value: text }
          : { ok: false };
    }
    case "long_text": {
      if (typeof raw !== "string" || raw.length > 5000) {
        return { ok: false };
      }

      return raw.trim() === "" ? { ok: true, value: null } : { ok: true, value: raw };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false };
      }

      return { ok: true, value: raw };
    }
    case "date": {
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return { ok: false };
      }

      const date = new Date(`${raw}T00:00:00Z`);

      return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw
        ? { ok: false }
        : { ok: true, value: raw };
    }
    case "url": {
      if (typeof raw !== "string" || raw.length > 500) {
        return { ok: false };
      }

      try {
        const url = new URL(raw.trim());

        return url.protocol === "http:" || url.protocol === "https:"
          ? { ok: true, value: url.toString() }
          : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    case "select": {
      return typeof raw === "string" && field.options.some((entry) => entry.value === raw)
        ? { ok: true, value: raw }
        : { ok: false };
    }
    case "multiselect": {
      if (!Array.isArray(raw)) {
        return { ok: false };
      }

      const seen = new Set<string>();

      for (const entry of raw) {
        if (
          typeof entry !== "string" ||
          seen.has(entry) ||
          !field.options.some((option) => option.value === entry)
        ) {
          return { ok: false };
        }

        seen.add(entry);
      }

      return { ok: true, value: seen.size === 0 ? null : [...seen] };
    }
  }
}

export type SaveProfileResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | "invalid"
        | "required"
        | "not_editable"
        | "unknown_field"
        | "signature_disabled"
        | "signature_too_long"
        | "signature_too_many_lines"
        | "signature_too_many_images"
        | "signature_too_many_links"
        | "custom_title_not_allowed"
        | "custom_title_too_long"
        | "blocked_word"
        | "too_many_featured";
      readonly fieldId?: string;
      readonly limit?: number;
    };

/** The group-merged signature limits for one member; zero characters disables signatures. */
export async function readSignatureLimits(sql: SQL, memberId: string): Promise<SignatureLimits> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  const limit = (key: string): number =>
    typeof settings[key] === "number" ? (settings[key] as number) : 0;

  return {
    maxChars: limit("members.signature_max_chars"),
    maxLines: limit("members.signature_max_lines"),
    maxImages: limit("members.signature_max_images"),
    maxLinks: limit("members.signature_max_links"),
  };
}

/** The member's custom-title permission and maximum length (task 5.1). */
export async function readCustomTitleLimits(
  sql: SQL,
  memberId: string,
): Promise<{ readonly enabled: boolean; readonly maxChars: number }> {
  const enabled = await can(sql, memberId, "custom_title");

  if (!enabled) {
    return { enabled: false, maxChars: 0 };
  }

  const settings = await loadMergedGroupSettings(sql, memberId);

  return {
    enabled: true,
    maxChars:
      typeof settings["members.custom_title_max_chars"] === "number"
        ? (settings["members.custom_title_max_chars"] as number)
        : 0,
  };
}

function countRenderedImages(html: string): number {
  return html.match(/<img\b/gi)?.length ?? 0;
}

function countRenderedLinks(html: string): number {
  return html.match(/<a\b/gi)?.length ?? 0;
}

interface SignatureValidation {
  readonly ok: true;
  readonly bodyHtml: string;
}

type SignatureOutcome =
  | SignatureValidation
  | {
      readonly ok: false;
      readonly code: Extract<SaveProfileResult, { readonly ok: false }>["code"];
      readonly limit?: number;
    };

/** Renders a signature and enforces the member's group limits (signatures spec). */
export async function validateMemberSignature(
  sql: SQL,
  memberId: string,
  bodyMd: string,
): Promise<SignatureOutcome> {
  const limits = await readSignatureLimits(sql, memberId);

  if (bodyMd.trim() === "") {
    return { ok: true, bodyHtml: "" };
  }

  if (limits.maxChars <= 0) {
    return { ok: false, code: "signature_disabled" };
  }

  if (bodyMd.length > limits.maxChars) {
    return { ok: false, code: "signature_too_long", limit: limits.maxChars };
  }

  if (bodyMd.split(/\r?\n/).length > limits.maxLines) {
    return { ok: false, code: "signature_too_many_lines", limit: limits.maxLines };
  }

  const rendered = await renderContent(bodyMd, {
    profile: "signature",
    context: { kind: "forum_post", forumId: "0" },
    authorId: memberId,
  });

  if (countRenderedImages(rendered.bodyHtml) > limits.maxImages) {
    return { ok: false, code: "signature_too_many_images", limit: limits.maxImages };
  }

  if (countRenderedLinks(rendered.bodyHtml) > limits.maxLinks) {
    return { ok: false, code: "signature_too_many_links", limit: limits.maxLinks };
  }

  return { ok: true, bodyHtml: rendered.bodyHtml };
}

export interface SaveMemberProfileInput {
  readonly memberId: string;
  readonly aboutMd: string;
  readonly hideOnline: boolean;
  readonly hideFromMemberList: boolean;
  /** Only changed when present, so a staff edit never resets the member's preference. */
  readonly hideSignatures?: boolean;
  readonly hideFriends?: boolean;
  /** Only changed when present (the member's own editor sends it, staff edits need not). */
  readonly signatureMd?: string;
  /** Only changed when present; null clears the custom title. */
  readonly customTitle?: string | null;
  /** The moderation bad-word list, when the caller has one (task 5.1 hook). */
  readonly blockedWords?: readonly string[];
  /** At most three awarded badge ids, when the member saves their featured badges. */
  readonly featuredBadges?: readonly string[];
  /** Raw JSON values keyed by field id; every key must be an editable field. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The fields this actor may edit; staff edits pass every field. */
  readonly fields: readonly ProfileField[];
}

/**
 * Saves a member profile in one transaction with the `member:{id}` tag bump (ADR 0006).
 * Required fields are checked only among fields the actor may edit, and values for any other
 * field are rejected instead of silently ignored.
 */
export async function saveMemberProfile(
  sql: SQL,
  input: SaveMemberProfileInput,
): Promise<SaveProfileResult> {
  const aboutMd = input.aboutMd;
  const byId = new Map(input.fields.map((field) => [field.id, field]));

  if (aboutMd.length > 20_000) {
    return { ok: false, code: "invalid" };
  }

  for (const fieldId of Object.keys(input.values)) {
    if (!byId.has(fieldId)) {
      return { ok: false, code: "not_editable", fieldId };
    }
  }

  const normalized = new Map<string, ProfileFieldValue>();

  for (const field of input.fields) {
    const raw = input.values[field.id];
    const result = normalizeValue(field, raw);

    if (!result.ok) {
      return { ok: false, code: "invalid", fieldId: field.id };
    }

    if (result.value !== null) {
      normalized.set(field.id, result.value);
    }

    if (field.required && emptyProfileFieldValue(result.value)) {
      return { ok: false, code: "required", fieldId: field.id };
    }
  }

  const aboutHtml =
    aboutMd.trim() === ""
      ? ""
      : (
          await renderSnapshot(aboutMd, {
            profile: "about",
            context: { kind: "forum_post", forumId: "0" },
            authorId: input.memberId,
          })
        ).bodyHtml;
  let signatureHtml: string | null = null;
  let customTitle: string | null | undefined = input.customTitle;

  if (typeof customTitle === "string" && customTitle.trim() !== "") {
    const titleText = customTitle.trim();

    if (!(await can(sql, input.memberId, "custom_title"))) {
      return { ok: false, code: "custom_title_not_allowed" };
    }

    const settings = await loadMergedGroupSettings(sql, input.memberId);
    const maxChars =
      typeof settings["members.custom_title_max_chars"] === "number"
        ? (settings["members.custom_title_max_chars"] as number)
        : 0;

    if (maxChars <= 0 || titleText.length > maxChars) {
      return {
        ok: false,
        code: "custom_title_too_long",
        ...(maxChars <= 0 ? {} : { limit: maxChars }),
      };
    }

    try {
      const rendered = await saveContent(titleText, {
        profile: "profile_field",
        context: { kind: "forum_post", forumId: "0" },
        authorId: input.memberId,
        checks: { blockedWords: input.blockedWords ?? [] },
      });
      customTitle = rendered.bodyText.trim() === "" ? null : rendered.bodyText.trim();
    } catch (error) {
      if (error instanceof ContentError && error.code === "blocked_word") {
        return { ok: false, code: "blocked_word" };
      }

      throw error;
    }
  }

  if (typeof customTitle === "string" && customTitle.trim() === "") {
    customTitle = null;
  }

  if (input.featuredBadges !== undefined) {
    const unique = new Set(input.featuredBadges);

    if (unique.size > 3 || unique.size !== input.featuredBadges.length) {
      return { ok: false, code: "too_many_featured" };
    }

    const awarded = new Set((await readMemberBadges(sql, input.memberId)).map((badge) => badge.id));

    if ([...unique].some((id) => !awarded.has(id))) {
      return { ok: false, code: "invalid" };
    }
  }

  if (input.signatureMd !== undefined) {
    const signature = await validateMemberSignature(sql, input.memberId, input.signatureMd);

    if (!signature.ok) {
      return {
        ok: false,
        code: signature.code,
        ...(signature.limit === undefined ? {} : { limit: signature.limit }),
      };
    }

    signatureHtml = signature.bodyHtml;
  }

  await runMutation({
    sql,
    mutation: memberProfileMutation,
    input: { memberId: input.memberId },
    apply: async (tx) => {
      await updateProfileRow(tx, input.memberId, {
        aboutMd,
        aboutHtml,
        hideOnline: input.hideOnline,
        hideFromMemberList: input.hideFromMemberList,
      });
      await replaceFieldValues(
        tx,
        input.memberId,
        normalized,
        input.fields.map((field) => field.id),
      );

      if (input.signatureMd !== undefined && signatureHtml !== null) {
        await updateMemberSignature(tx, input.memberId, {
          bodyMd: input.signatureMd,
          bodyHtml: signatureHtml,
        });
      }

      if (input.hideSignatures !== undefined) {
        await updateHideSignatures(tx, input.memberId, input.hideSignatures);
      }

      if (input.hideFriends !== undefined) {
        await updateHideFriends(tx, input.memberId, input.hideFriends);
      }

      if (customTitle !== undefined) {
        await updateCustomTitle(tx, input.memberId, customTitle);
      }

      if (input.featuredBadges !== undefined) {
        await replaceFeaturedBadges(tx, input.memberId, input.featuredBadges);
      }

      return { memberId: input.memberId };
    },
  });

  return { ok: true };
}
