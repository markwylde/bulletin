import type { ReportDetail } from "@bulletin/domain/reports";
import { parseReportDetail } from "./page.ts";

const USER_API_URL = process.env.USER_API_INTERNAL_URL ?? "http://user-api:3001";

export interface ReportDetailRead {
  readonly status: number;
  readonly detail: ReportDetail | null;
}

/** The subset of `fetch` the read needs; injected so the page path is testable. */
export type ReportDetailFetch = (
  input: string,
  init?: { readonly headers?: Record<string, string>; readonly cache?: RequestCache },
) => Promise<Response>;

/**
 * Reading a PM report appends an audited `moderation_log` row, and user-app holds SELECT
 * only on that table (ADR 0001). The audited read therefore belongs to user-api: the SSR
 * page forwards the session cookie instead of opening the write path itself.
 */
export async function readReportDetailFromApi(options: {
  readonly reportId: string;
  readonly cookie: string | null;
  readonly fetchImpl?: ReportDetailFetch;
  readonly baseUrl?: string;
}): Promise<ReportDetailRead> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? USER_API_URL;

  try {
    const response = await fetchImpl(
      `${baseUrl}/api/reports/${encodeURIComponent(options.reportId)}`,
      {
        headers: options.cookie === null ? {} : { cookie: options.cookie },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return { status: response.status, detail: null };
    }

    const detail = parseReportDetail(await response.json().catch(() => null));

    return detail === null ? { status: 503, detail: null } : { status: 200, detail };
  } catch {
    return { status: 503, detail: null };
  }
}
