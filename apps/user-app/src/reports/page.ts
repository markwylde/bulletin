import {
  listReports,
  type ReportDetail,
  type ReportListItem,
  type ReportStatus,
  reportAccess,
} from "@bulletin/domain/reports";
import type { Locale, Translator } from "@bulletin/i18n";
import { type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

export interface ReportListRow {
  readonly id: string;
  readonly status: string;
  readonly statusKey: string;
  readonly targetLabel: string;
  readonly subject: string;
  readonly href: string | null;
  readonly assignee: string;
  readonly reporters: readonly {
    readonly id: string;
    readonly name: string;
    readonly reason: string;
    readonly comment: string;
  }[];
  readonly commentCount: number;
  readonly updatedAt: string;
}

export interface ReportsPageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly total: number;
    readonly hasReports: boolean;
    readonly reports: readonly ReportListRow[];
    readonly status: string;
    readonly statusOptions: readonly { readonly value: ReportStatus; readonly label: string }[];
    readonly filters: readonly {
      readonly value: string;
      readonly label: string;
      readonly href: string;
    }[];
    readonly flags: Readonly<Record<string, boolean>>;
  };
}

function formatDate(locale: Locale, value: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function statusLabel(translate: Translator, status: ReportStatus): string {
  switch (status) {
    case "open":
      return translate("report.status.open");
    case "in_progress":
      return translate("report.status.inProgress");
    case "resolved":
      return translate("report.status.resolved");
    case "rejected":
      return translate("report.status.rejected");
  }
}

function reasonLabel(translate: Translator, reason: string): string {
  switch (reason) {
    case "spam":
      return translate("report.reason.spam");
    case "abuse":
      return translate("report.reason.abuse");
    case "harassment":
      return translate("report.reason.harassment");
    case "off_topic":
      return translate("report.reason.offTopic");
    default:
      return translate("report.reason.other");
  }
}

function targetLabel(translate: Translator, report: ReportListItem): string {
  switch (report.targetType) {
    case "post":
      return translate("report.target.post");
    case "member":
      return translate("report.target.member");
    case "pm":
      return translate("report.target.pm");
  }
}

function row(locale: Locale, translate: Translator, report: ReportListItem): ReportListRow {
  return {
    id: report.id,
    status: report.status,
    statusKey: statusLabel(translate, report.status),
    targetLabel: targetLabel(translate, report),
    subject:
      report.subject.label !== ""
        ? report.subject.label
        : translate("report.subject.privateMessage"),
    href: report.subject.href,
    assignee: report.assigneeName ?? translate("report.unassigned"),
    reporters: report.reporters.map((reporter) => ({
      id: reporter.memberId,
      name: reporter.memberName ?? translate("member.deletedName"),
      reason: reasonLabel(translate, reporter.reason),
      comment: reporter.comment,
    })),
    commentCount: report.comments.length,
    updatedAt: formatDate(locale, report.updatedAt),
  };
}

export const REPORT_STATUS_OPTIONS: readonly ReportStatus[] = [
  "open",
  "in_progress",
  "resolved",
  "rejected",
];

export async function buildReportsPage(input: {
  readonly sql: SQL;
  readonly memberId: string;
  readonly sessionId: string | null;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly status: ReportStatus | null;
}): Promise<ReportsPageData | null> {
  const access = await reportAccess(input.sql, input.memberId, input.sessionId);

  if (!access.any) {
    return null;
  }

  const page = await listReports(input.sql, {
    actorId: input.memberId,
    sessionId: input.sessionId,
    ...(input.status === null ? {} : { status: input.status }),
    limit: 50,
    offset: 0,
  });

  return {
    title: input.translate("report.centre.title"),
    breadcrumbs: [{ label: input.translate("report.centre.title"), href: null }],
    viewModel: {
      total: page.total,
      hasReports: page.reports.length > 0,
      reports: page.reports.map((report) => row(input.locale, input.translate, report)),
      status: input.status ?? "all",
      statusOptions: REPORT_STATUS_OPTIONS.map((status) => ({
        value: status,
        label: statusLabel(input.translate, status),
      })),
      filters: [
        { value: "all", label: input.translate("report.filter.all"), href: "/moderation/reports" },
        ...REPORT_STATUS_OPTIONS.map((status) => ({
          value: status,
          label: statusLabel(input.translate, status),
          href: `/moderation/reports?status=${status}`,
        })),
      ],
      flags: {},
    },
  };
}

export interface ReportPmMessageView {
  readonly messageId: string;
  readonly author: string;
  readonly body: SafeHtml;
  readonly time: string;
  readonly reported: boolean;
}

export interface ReportDetailView {
  readonly id: string;
  readonly status: ReportStatus;
  readonly statusKey: string;
  readonly targetLabel: string;
  readonly subject: string;
  readonly subjectHref: string | null;
  readonly assignee: string;
  readonly assigned: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reporters: readonly {
    readonly id: string;
    readonly name: string;
    readonly reason: string;
    readonly comment: string;
    readonly time: string;
  }[];
  readonly comments: readonly {
    readonly id: string;
    readonly actor: string;
    readonly body: string;
    readonly time: string;
  }[];
  readonly pmMessages: readonly ReportPmMessageView[] | null;
  readonly canComment: boolean;
}

export interface ReportDetailPageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly report: ReportDetailView;
    readonly statusOptions: readonly { readonly value: ReportStatus; readonly label: string }[];
    readonly flags: Readonly<Record<string, boolean>>;
  };
}

export function buildReportDetailView(input: {
  readonly report: ReportDetail;
  readonly locale: Locale;
  readonly translate: Translator;
}): ReportDetailPageData {
  const { report, locale, translate } = input;

  return {
    title: translate("report.detail.title", { id: report.id }),
    breadcrumbs: [
      { label: translate("report.centre.title"), href: "/moderation/reports" },
      { label: translate("report.detail.title", { id: report.id }), href: null },
    ],
    viewModel: {
      report: {
        id: report.id,
        status: report.status,
        statusKey: statusLabel(translate, report.status),
        targetLabel: targetLabel(translate, report),
        subject:
          report.subject.label !== ""
            ? report.subject.label
            : translate("report.subject.privateMessage"),
        subjectHref: report.subject.href,
        assignee: report.assigneeName ?? translate("report.unassigned"),
        assigned: report.assigneeId !== null,
        createdAt: formatDate(locale, report.createdAt),
        updatedAt: formatDate(locale, report.updatedAt),
        reporters: report.reporters.map((reporter) => ({
          id: reporter.memberId,
          name: reporter.memberName ?? translate("member.deletedName"),
          reason: reasonLabel(translate, reporter.reason),
          comment: reporter.comment,
          time: formatDate(locale, reporter.createdAt),
        })),
        comments: report.comments.map((comment) => ({
          id: comment.id,
          actor: comment.actorName ?? translate("member.deletedName"),
          body: comment.body,
          time: formatDate(locale, comment.createdAt),
        })),
        pmMessages:
          report.pmMessages === null
            ? null
            : report.pmMessages.map((message) => ({
                messageId: message.messageId,
                author: message.authorName ?? translate("member.deletedName"),
                // Stored pipeline HTML; the whole page is sanitised again on render (ADR 0008).
                body: safeHtml(message.bodyHtml),
                time: formatDate(locale, message.createdAt),
                reported: message.reported,
              })),
        canComment: true,
      },
      statusOptions: REPORT_STATUS_OPTIONS.map((status) => ({
        value: status,
        label: statusLabel(translate, status),
      })),
      flags: {},
    },
  };
}

/** Parses the user-api detail payload into the domain shape the view builder needs. */
export function parseReportDetail(value: unknown): ReportDetail | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const report = record.report;

  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return null;
  }

  const candidate = report as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.targetType !== "string" ||
    typeof candidate.targetId !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    targetType: candidate.targetType as ReportDetail["targetType"],
    targetId: candidate.targetId,
    status: candidate.status as ReportStatus,
    assigneeId: typeof candidate.assigneeId === "string" ? candidate.assigneeId : null,
    assigneeName: typeof candidate.assigneeName === "string" ? candidate.assigneeName : null,
    createdAt: new Date(candidate.createdAt),
    updatedAt: new Date(candidate.updatedAt),
    subject:
      typeof candidate.subject === "object" && candidate.subject !== null
        ? {
            label:
              typeof (candidate.subject as { label?: unknown }).label === "string"
                ? (candidate.subject as { label: string }).label
                : "",
            href:
              typeof (candidate.subject as { href?: unknown }).href === "string"
                ? (candidate.subject as { href: string }).href
                : null,
          }
        : { label: "", href: null },
    reporters: Array.isArray(candidate.reporters)
      ? candidate.reporters.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const row = entry as Record<string, unknown>;
          return typeof row.memberId === "string" && typeof row.reason === "string"
            ? [
                {
                  memberId: row.memberId,
                  memberName: typeof row.memberName === "string" ? row.memberName : null,
                  reason: row.reason as ReportDetail["reporters"][number]["reason"],
                  comment: typeof row.comment === "string" ? row.comment : "",
                  createdAt:
                    typeof row.createdAt === "string" ? new Date(row.createdAt) : new Date(0),
                },
              ]
            : [];
        })
      : [],
    comments: Array.isArray(candidate.comments)
      ? candidate.comments.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const row = entry as Record<string, unknown>;
          return typeof row.id === "string" && typeof row.body === "string"
            ? [
                {
                  id: row.id,
                  actorId: typeof row.actorId === "string" ? row.actorId : null,
                  actorName: typeof row.actorName === "string" ? row.actorName : null,
                  body: row.body,
                  createdAt:
                    typeof row.createdAt === "string" ? new Date(row.createdAt) : new Date(0),
                },
              ]
            : [];
        })
      : [],
    pmMessages: Array.isArray(candidate.pmMessages)
      ? candidate.pmMessages.flatMap((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return [];
          }
          const row = entry as Record<string, unknown>;
          return typeof row.messageId === "string" && typeof row.bodyHtml === "string"
            ? [
                {
                  messageId: row.messageId,
                  authorName: typeof row.authorName === "string" ? row.authorName : null,
                  bodyHtml: row.bodyHtml,
                  createdAt:
                    typeof row.createdAt === "string" ? new Date(row.createdAt) : new Date(0),
                  reported: row.reported === true,
                },
              ]
            : [];
        })
      : null,
  };
}
