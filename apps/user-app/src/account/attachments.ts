import {
  listMemberAttachments,
  readStorageUsage,
  readUploadLimits,
} from "@bulletin/domain/attachments";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";
import { attachmentPath, formatFileSize } from "../topics/attachments.ts";

export interface AttachmentsPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
}

export interface AttachmentsPageData {
  readonly title: string;
  readonly memberId: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly usageLabel: string;
    readonly hasAttachments: boolean;
    readonly attachments: readonly {
      readonly id: string;
      readonly filename: string;
      readonly href: string;
      readonly meta: string;
      readonly createdAt: string;
    }[];
  };
}

/** "My attachments": quota usage and the member's own published files (task 4.3). */
export async function buildAttachmentsPage(
  input: AttachmentsPageInput,
): Promise<AttachmentsPageData> {
  const [limits, usage, attachments] = await Promise.all([
    readUploadLimits(input.sql, input.memberId),
    readStorageUsage(input.sql, input.memberId),
    listMemberAttachments(input.sql, input.memberId),
  ]);
  const remaining = Math.max(limits.quotaBytes - usage.usedBytes - usage.reservedBytes, 0);
  const title = input.translate("account.attachments.title");
  const date = new Intl.DateTimeFormat(input.locale, { dateStyle: "medium" });

  return {
    title,
    memberId: input.memberId,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: title, href: null },
    ],
    viewModel: {
      usageLabel: input.translate("account.attachments.usage", {
        used: formatFileSize(usage.usedBytes, input.locale),
        quota: formatFileSize(limits.quotaBytes, input.locale),
        remaining: formatFileSize(remaining, input.locale),
      }),
      hasAttachments: attachments.length > 0,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        href: attachmentPath(attachment.id, attachment.filename),
        meta: [
          formatFileSize(attachment.sizeBytes, input.locale),
          input.translate("attachment.downloads", { count: attachment.downloadCount }),
        ].join(" · "),
        createdAt: date.format(attachment.createdAt),
      })),
    },
  };
}
