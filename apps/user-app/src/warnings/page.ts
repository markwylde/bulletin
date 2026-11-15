import { canonicalUrl } from "@bulletin/domain/urls";
import {
  activeWarningPoints,
  canViewWarningHistory,
  hasUnacknowledgedWarning,
  listMemberRestrictions,
  listMemberWarnings,
  listStaffWarnings,
  listWarningReasons,
  readWarningContentTargets,
} from "@bulletin/domain/warnings";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

function formatDate(locale: Locale, value: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function restrictionLabel(translate: Translator, kind: string): string {
  switch (kind) {
    case "posts_require_approval":
      return translate("warnings.restriction.postsRequireApproval");
    case "cannot_post":
      return translate("warnings.restriction.cannotPost");
    case "banned":
      return translate("warnings.restriction.banned");
    default:
      return kind;
  }
}

export async function buildOwnWarningsPage(input: {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
}): Promise<{
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: Record<string, unknown>;
}> {
  const [warnings, points, restrictions, pendingAck] = await Promise.all([
    listMemberWarnings(input.sql, input.memberId, input.locale),
    activeWarningPoints(input.sql, input.memberId),
    listMemberRestrictions(input.sql, input.memberId),
    hasUnacknowledgedWarning(input.sql, input.memberId),
  ]);

  return {
    title: input.translate("warnings.title"),
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: input.translate("warnings.title"), href: null },
    ],
    viewModel: {
      points,
      pendingAck,
      hasWarnings: warnings.length > 0,
      warnings: warnings.map((warning) => ({
        id: warning.id,
        reason: warning.reasonLabel,
        points: warning.points,
        expiresAt: formatDate(input.locale, warning.expiresAt),
        memberNote: warning.memberNote,
        revoked: warning.revokedAt !== null,
      })),
      restrictions: restrictions.map((restriction) => ({
        kind: restriction.kind,
        label: restrictionLabel(input.translate, restriction.kind),
        until: restriction.until === null ? null : formatDate(input.locale, restriction.until),
      })),
      flags: {},
    },
  };
}

export async function buildStaffWarningsPage(input: {
  readonly sql: SQL;
  readonly actorId: string;
  readonly sessionId: string | null;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
}): Promise<{
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: Record<string, unknown>;
} | null> {
  if (!(await canViewWarningHistory(input.sql, input.actorId, input.sessionId))) {
    return null;
  }

  const [member] = (await input.sql`
    SELECT display_name FROM core.members WHERE id = ${input.memberId}
  `) as Array<{ display_name: string | null }>;

  if (member === undefined) {
    return null;
  }

  const [warnings, points, restrictions, reasons] = await Promise.all([
    listStaffWarnings(input.sql, input.memberId, input.locale),
    activeWarningPoints(input.sql, input.memberId),
    listMemberRestrictions(input.sql, input.memberId),
    listWarningReasons(input.sql, { enabledOnly: true }),
  ]);
  const contentIds = warnings.flatMap((warning) =>
    warning.contentType === "post" && warning.contentId !== null ? [warning.contentId] : [],
  );
  const contentTargets = await readWarningContentTargets(input.sql, contentIds);
  const contentHrefs = new Map(
    [...contentTargets].map(([id, target]) => [
      id,
      canonicalUrl("topic", target.topicId, target.slug, { postId: id }),
    ]),
  );

  return {
    title: input.translate("warnings.staffTitle", {
      member: member.display_name ?? input.translate("member.deletedName"),
    }),
    breadcrumbs: [{ label: input.translate("warnings.title"), href: null }],
    viewModel: {
      memberId: input.memberId,
      points,
      warnings: warnings.map((warning) => ({
        id: warning.id,
        reason: warning.reasonLabel,
        points: warning.points,
        expiresAt: formatDate(input.locale, warning.expiresAt),
        memberNote: warning.memberNote,
        staffNote: warning.staffNote,
        revoked: warning.revokedAt !== null,
        revokeReason: warning.revokeReason,
        ackRequired: warning.ackRequired,
        acked: warning.ackedAt !== null,
        contentHref:
          warning.contentId === null ? null : (contentHrefs.get(warning.contentId) ?? null),
      })),
      reasons: reasons.map((reason) => ({
        id: reason.id,
        label: reason.labels[input.locale] ?? reason.labels.en ?? reason.key,
        points: reason.points,
        expiryDays: reason.expiryDays,
        allowPointsOverride: reason.allowPointsOverride,
      })),
      restrictions: restrictions.map((restriction) => ({
        kind: restriction.kind,
        label: restrictionLabel(input.translate, restriction.kind),
        until: restriction.until === null ? null : formatDate(input.locale, restriction.until),
      })),
      flags: {},
    },
  };
}
