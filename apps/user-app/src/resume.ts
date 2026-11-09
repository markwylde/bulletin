import {
  type AuthFetch,
  type StashedRequest,
  stashedBodyInit,
} from "@bulletin/domain/auth/browser";

export type ResumeResult = "none" | "success" | "retained";

export interface ResumeOptions {
  readonly take: () => StashedRequest | null;
  readonly clear: () => void;
  readonly fetch: AuthFetch;
}

/**
 * Resubmits a stashed request. The saved body is cleared only after a successful
 * response; failures and network errors keep it for another retry.
 */
export async function resumeStashedRequest(options: ResumeOptions): Promise<ResumeResult> {
  const stashed = options.take();

  if (stashed === null) {
    return "none";
  }

  try {
    const response = await options.fetch(stashed.url, {
      method: stashed.method,
      headers: stashed.headers,
      body: stashedBodyInit(stashed.body),
    });

    if (!response.ok) {
      return "retained";
    }

    options.clear();
    return "success";
  } catch {
    return "retained";
  }
}
