/** Localised conversation failure presentation, shared by the inbox and conversation page. */
export interface ConversationErrorLabels {
  readonly recipientLimit: string;
  readonly dailyLimit: string;
  readonly quota: string;
  readonly manage: string;
  readonly pmDisabled: string;
  readonly recipientUnavailable: string;
  readonly inviteBlocked: string;
  readonly alreadyParticipant: string;
  readonly notFound: string;
}

export interface ConversationApiError {
  readonly code?: string;
  readonly limit?: number;
  readonly quota?: number;
}

export interface ConversationErrorPresentation {
  readonly text: string;
  readonly manageUrl: string | null;
}

const LABEL_BY_CODE: Readonly<Record<string, keyof ConversationErrorLabels>> = {
  recipient_limit: "recipientLimit",
  daily_limit: "dailyLimit",
  quota_reached: "quota",
  pm_disabled: "pmDisabled",
  recipient_unavailable: "recipientUnavailable",
  invite_blocked: "inviteBlocked",
  already_participant: "alreadyParticipant",
  not_found: "notFound",
};

/**
 * Uses the numeric limit from the API response, rather than the possibly stale limit rendered
 * into the page. Quota errors also point at the member's conversation management page.
 */
export function conversationErrorPresentation(
  error: ConversationApiError,
  labels: ConversationErrorLabels,
): ConversationErrorPresentation | null {
  if (error.code === "recipient_limit" && typeof error.limit === "number") {
    return {
      text: labels.recipientLimit.replace("__limit__", String(error.limit)),
      manageUrl: null,
    };
  }

  const key = error.code === undefined ? undefined : LABEL_BY_CODE[error.code];

  if (key === undefined) {
    return null;
  }

  return {
    text: labels[key],
    manageUrl: error.code === "quota_reached" ? "/conversations" : null,
  };
}
