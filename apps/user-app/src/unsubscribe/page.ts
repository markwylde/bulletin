import {
  isNotificationTypeValue,
  type UnsubscribeScope,
  verifyUnsubscribeToken,
} from "@bulletin/domain/notifications";
import type { Translator } from "@bulletin/i18n";
import { NOTIFICATION_TYPE_LABELS } from "../account/notification-labels.ts";

export interface UnsubscribePageInput {
  readonly token: string | null;
  readonly secret: string;
  readonly translate: Translator;
  readonly confirmed?: boolean;
}

export interface UnsubscribePageData {
  readonly title: string;
  readonly body: string;
  readonly state: "confirm" | "invalid" | "confirmed";
  readonly showForm: boolean;
  readonly token: string;
  readonly confirmLabel: string;
}

function typeLabel(translate: Translator, type: UnsubscribeScope): string {
  return type === "digest"
    ? translate("unsubscribe.digestType")
    : translate(NOTIFICATION_TYPE_LABELS[type].labelKey);
}

/**
 * The unsubscribe confirmation page. A GET only renders this; it never changes a preference,
 * so mail scanners cannot unsubscribe anyone (notifications spec, ADR 0018).
 */
export function buildUnsubscribePage(input: UnsubscribePageInput): UnsubscribePageData {
  if (input.confirmed === true) {
    return {
      title: input.translate("unsubscribe.confirmedTitle"),
      body: input.translate("unsubscribe.confirmedBody"),
      state: "confirmed",
      showForm: false,
      token: "",
      confirmLabel: "",
    };
  }

  const claims = input.token === null ? null : verifyUnsubscribeToken(input.secret, input.token);

  if (claims === null) {
    return {
      title: input.translate("unsubscribe.invalidTitle"),
      body: input.translate("unsubscribe.invalidBody"),
      state: "invalid",
      showForm: false,
      token: "",
      confirmLabel: "",
    };
  }

  return {
    title: input.translate("unsubscribe.title"),
    body: input.translate("unsubscribe.intro", { type: typeLabel(input.translate, claims.type) }),
    state: "confirm",
    showForm: true,
    token: input.token ?? "",
    confirmLabel: input.translate("unsubscribe.confirm"),
  };
}

export function isUnsubscribeScope(value: string): value is UnsubscribeScope {
  return value === "digest" || isNotificationTypeValue(value);
}
