export interface UploadErrorLabels {
  readonly uploadQuota: string;
  readonly uploadQuotaRemaining: string;
  readonly uploadTooLarge: string;
  readonly uploadType: string;
  readonly uploadRejected: string;
  readonly uploadFailed: string;
}

export interface UploadErrorBody {
  readonly code?: string;
  readonly remainingBytes?: number;
}

/** Localised size for the quota message; short Intl units, never a hard-coded "MB". */
export function formatUploadBytes(bytes: number, locale: string): string {
  const value = Math.max(0, bytes);

  if (value < 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(value);
  }

  if (value < 1024 * 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(value / 1024);
  }

  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value / (1024 * 1024));
}

export function uploadErrorMessage(
  labels: UploadErrorLabels,
  body: UploadErrorBody,
  locale: string,
): string {
  switch (body.code) {
    case "quota_exceeded":
      return typeof body.remainingBytes === "number"
        ? labels.uploadQuotaRemaining.replace(
            "%remaining%",
            formatUploadBytes(body.remainingBytes, locale),
          )
        : labels.uploadQuota;
    case "file_too_large":
      return labels.uploadTooLarge;
    case "type_not_allowed":
      return labels.uploadType;
    case "attachment_rejected":
      return labels.uploadRejected;
    default:
      return labels.uploadFailed;
  }
}
