/** Stable outcomes the API layer maps to status codes and message keys. */
export type TopicMutationCode =
  | "invalid_request"
  | "invalid_title"
  | "invalid_body"
  | "invalid_poll"
  | "invalid_prefix"
  | "prefix_required"
  | "forum_not_found"
  | "topic_not_found"
  | "post_not_found"
  | "forbidden"
  | "posting_suspended"
  | "acknowledgement_required"
  | "locked"
  | "edit_window_expired"
  | "first_post_requires_topic_delete";

export type TopicMutationOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly code: TopicMutationCode };

/** Thrown inside a transaction so a late check rolls every write back. */
export class TopicRejected extends Error {
  readonly code: TopicMutationCode;

  constructor(code: TopicMutationCode) {
    super(`Topic mutation rejected: ${code}`);
    this.name = "TopicRejected";
    this.code = code;
  }
}

export function reject(code: TopicMutationCode): never {
  throw new TopicRejected(code);
}

export function rejectOutcome(error: unknown): TopicMutationOutcome<never> | null {
  return error instanceof TopicRejected ? { ok: false, code: error.code } : null;
}
