import {
  awardBadge,
  BADGE_RULE_TYPES,
  type BadgeInput,
  type BadgeRecord,
  type BadgeRule,
  badgeLabel,
  deleteBadge,
  listBadges,
  readMemberBadges,
  revokeBadge,
  saveBadge,
} from "@bulletin/domain/badges";
import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

const LOCALES: readonly Locale[] = ["en", "es", "fr"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labels(value: unknown): Readonly<Record<Locale, string>> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result: Partial<Record<Locale, string>> = {};

  for (const locale of LOCALES) {
    const text = value[locale];

    if (typeof text !== "string" || text.trim() === "") {
      return null;
    }

    result[locale] = text.trim();
  }

  return result as Readonly<Record<Locale, string>>;
}

function rule(value: unknown): BadgeRule | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !(BADGE_RULE_TYPES as readonly string[]).includes(value.type) ||
    typeof value.threshold !== "number" ||
    !Number.isSafeInteger(value.threshold) ||
    value.threshold < 0
  ) {
    return undefined;
  }

  const forumId =
    typeof value.forumId === "string" && /^\d+$/.test(value.forumId) ? value.forumId : null;

  if (value.type === "posts_in_forum" ? forumId === null : forumId !== null) {
    return undefined;
  }

  return {
    type: value.type as BadgeRule["type"],
    threshold: value.threshold,
    forumId,
  };
}

export function parseBadgeInput(value: unknown): BadgeInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const labelsValue = labels(value.labels);
  const descriptions = labels(value.descriptionLabels);
  const parsedRule = rule(value.rule);
  const position = value.position ?? 0;

  if (
    labelsValue === null ||
    descriptions === null ||
    parsedRule === undefined ||
    typeof value.key !== "string" ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(value.key) ||
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < 0
  ) {
    return null;
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
    key: value.key,
    labels: labelsValue,
    descriptionLabels: descriptions,
    imageKey:
      typeof value.imageKey === "string" && value.imageKey.trim() !== ""
        ? value.imageKey.trim()
        : null,
    position,
    rule: parsedRule,
  };
}

export async function listBadgesForStaff(sql: SQL): Promise<readonly BadgeRecord[]> {
  return listBadges(sql);
}

export async function mutateBadge(
  sql: SQL,
  actorId: string,
  body: unknown,
): Promise<
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: string }
> {
  if (!isRecord(body) || typeof body.action !== "string") {
    return { ok: false, code: "invalid" };
  }

  if (body.action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    const removed = await deleteBadge(sql, id);

    if (!removed) {
      return { ok: false, code: "not_found" };
    }

    await writeAdminLog(sql, {
      actorMemberId: actorId,
      action: "badge.delete",
      targetType: "badge",
      targetId: id,
      summary: { id },
    });

    return { ok: true, id };
  }

  if (body.action !== "save") {
    return { ok: false, code: "invalid" };
  }

  const parsed = parseBadgeInput(body.badge);

  if (parsed === null) {
    return { ok: false, code: "invalid" };
  }

  const id = await saveBadge(sql, parsed);

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: parsed.id === null ? "badge.create" : "badge.update",
    targetType: "badge",
    targetId: id,
    summary: { key: parsed.key, rule: parsed.rule },
  });

  return { ok: true, id };
}

export interface StaffMemberBadge {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly awarded: boolean;
  readonly featured: boolean;
}

export async function listMemberBadgesForStaff(
  sql: SQL,
  memberId: string,
): Promise<readonly StaffMemberBadge[]> {
  const [all, awarded] = await Promise.all([listBadges(sql), readMemberBadges(sql, memberId)]);
  const awardedIds = new Set(awarded.map((badge) => badge.id));
  const featuredIds = new Set(awarded.filter((badge) => badge.featured).map((badge) => badge.id));

  return all.map((badge) => ({
    id: badge.id,
    key: badge.key,
    label: badgeLabel(badge, "en"),
    awarded: awardedIds.has(badge.id),
    featured: featuredIds.has(badge.id),
  }));
}

export async function mutateMemberBadge(
  sql: SQL,
  actorId: string,
  body: unknown,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  if (
    !isRecord(body) ||
    typeof body.memberId !== "string" ||
    !/^\d+$/.test(body.memberId) ||
    typeof body.badgeId !== "string" ||
    !/^\d+$/.test(body.badgeId) ||
    (body.action !== "award" && body.action !== "revoke")
  ) {
    return { ok: false, code: "invalid" };
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const changed =
    body.action === "award"
      ? await awardBadge(sql, {
          memberId: body.memberId,
          badgeId: body.badgeId,
          actorId,
          reason: reason === "" ? null : reason,
        })
      : await revokeBadge(sql, {
          memberId: body.memberId,
          badgeId: body.badgeId,
          reason: reason === "" ? null : reason,
        });

  if (!changed) {
    return { ok: false, code: "not_found" };
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: `member.badge.${body.action}`,
    targetType: "member",
    targetId: body.memberId,
    summary: { badgeId: body.badgeId, reason },
  });

  return { ok: true };
}
