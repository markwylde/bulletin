import type { Logger } from "@bulletin/config";
import { ensurePgBossQueue } from "@bulletin/db/events";
import {
  createUnsubscribeToken,
  type NotificationEmailContext,
  type NotificationType,
  notificationEmailContext,
  type SmtpMessage,
  sendSmtpMail,
} from "@bulletin/domain/notifications";
import { canonicalUrl } from "@bulletin/domain/urls";
import {
  type Catalog,
  createServerT,
  isLocale,
  type Locale,
  type Translator,
} from "@bulletin/i18n";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import en from "../i18n/merged/en.json";
import es from "../i18n/merged/es.json";
import fr from "../i18n/merged/fr.json";
import type { WorkerFlags } from "./flags.ts";

export const EMAIL_QUEUE = "email";

/** How long an unsubscribe link remains valid. */
export const UNSUBSCRIBE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export const WORKER_CATALOGS = { en, es, fr } as const satisfies Record<Locale, Catalog>;

export interface EmailOptions {
  readonly smtpUrl: string;
  readonly mailFrom: string;
  readonly userOrigin: string;
  readonly unsubscribeSecret: string;
  readonly logger?: Logger;
  readonly flags?: WorkerFlags;
}

export interface EmailJob {
  readonly intentId: string;
}

function localeOf(value: string | null): Locale {
  return value !== null && isLocale(value) ? value : "en";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function subjectFor(translate: Translator, type: NotificationType, topic: string): string {
  switch (type) {
    case "topic.reply":
      return translate("email.subject.topic.reply", { topic });
    case "topic.created":
      return translate("email.subject.topic.created");
    case "post.mention":
      return translate("email.subject.post.mention", { topic });
    case "post.quote":
      return translate("email.subject.post.quote", { topic });
    case "reaction.added":
      return translate("email.subject.reaction.added");
    case "reputation.given":
      return translate("email.subject.reputation.given");
    case "member.promoted":
      return translate("email.subject.member.promoted");
    case "friend.accepted":
      return translate("email.subject.friend.accepted");
    case "badge.awarded":
      return translate("email.subject.badge.awarded");
    case "conversation.message":
      return translate("email.subject.conversation.message", { topic });
  }
}

function bodyFor(
  translate: Translator,
  type: NotificationType,
  actor: string,
  topic: string,
): string {
  switch (type) {
    case "topic.reply":
      return translate("email.body.topic.reply", { actor, topic });
    case "topic.created":
      return translate("email.body.topic.created", { actor, topic });
    case "post.mention":
      return translate("email.body.post.mention", { actor, topic });
    case "post.quote":
      return translate("email.body.post.quote", { actor, topic });
    case "reaction.added":
      return translate("email.body.reaction.added", { actor });
    case "reputation.given":
      return translate("email.body.reputation.given", { actor });
    case "member.promoted":
      return translate("email.body.member.promoted");
    case "friend.accepted":
      return translate("email.body.friend.accepted", { actor });
    case "badge.awarded":
      return translate("email.body.badge.awarded", { actor });
    case "conversation.message":
      return translate("email.body.conversation.message", { actor, topic });
  }
}

/**
 * Builds the localised email for one notification. It carries only the actor's name, the topic
 * title and links: never the post body or quoted text (notifications spec, ADR 0011).
 */
export function buildNotificationEmail(input: {
  readonly row: NotificationEmailContext;
  readonly to: string;
  readonly options: EmailOptions;
}): SmtpMessage {
  const locale = localeOf(input.row.locale);
  const translate = createServerT(locale, { shipped: WORKER_CATALOGS });
  const type: NotificationType = input.row.type;
  const actor = input.row.actorName ?? translate("email.fallbackActor", {});
  const topic = input.row.conversationTitle ?? input.row.topicTitle ?? "";
  const greeting = translate("email.greeting", {
    name: input.row.recipientName ?? translate("email.fallbackName", {}),
  });
  const summary = bodyFor(translate, type, actor, topic);
  const openUrl =
    input.row.conversationId !== null
      ? `${input.options.userOrigin}/conversations/${input.row.conversationId}`
      : input.row.topicId !== null && input.row.topicSlug !== null
        ? `${input.options.userOrigin}${canonicalUrl(
            "topic",
            input.row.topicId,
            input.row.topicSlug,
            input.row.postId === null ? {} : { postId: input.row.postId },
          )}`
        : null;
  const token = createUnsubscribeToken(input.options.unsubscribeSecret, {
    memberId: input.row.memberId,
    type,
    expiresAt: Date.now() + UNSUBSCRIBE_TOKEN_TTL_MS,
  });
  const pageUrl = `${input.options.userOrigin}/unsubscribe?token=${encodeURIComponent(token)}`;
  const oneClickUrl = `${input.options.userOrigin}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
  const lines = [greeting, "", summary];

  if (openUrl !== null) {
    lines.push("", translate("email.open", { url: openUrl }));
  }

  lines.push("", translate("email.unsubscribe", { url: pageUrl }));
  const text = lines.join("\n");
  const htmlLines = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<p>${escapeHtml(summary)}</p>`,
    ...(openUrl === null
      ? []
      : [
          `<p><a href="${escapeHtml(openUrl)}">${escapeHtml(translate("email.open", { url: openUrl }))}</a></p>`,
        ]),
    `<p class="muted"><a href="${escapeHtml(pageUrl)}">${escapeHtml(
      translate("email.unsubscribe", { url: pageUrl }),
    )}</a></p>`,
  ];

  return {
    from: input.options.mailFrom,
    to: input.to,
    subject: subjectFor(translate, type, topic),
    text,
    html: `<!doctype html><html><body>${htmlLines.join("")}</body></html>`,
    headers: {
      // RFC 8058: the one-click endpoint accepts a POST with this body, no browser needed.
      "List-Unsubscribe": `<${oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

/**
 * One email delivery. The address comes only from `pii.delivery_target`, which writes the audit
 * row in this transaction; the intent is marked delivered only after the SMTP server accepted
 * the message. A failure rolls all of it back so the job retries (ADR 0012).
 */
export async function deliverNotificationEmail(
  sql: SQL,
  options: EmailOptions,
  intentId: string,
): Promise<"sent" | "skipped"> {
  return sql.begin(async (tx): Promise<"sent" | "skipped"> => {
    const row = await notificationEmailContext(tx, intentId);

    if (row === null) {
      return "skipped";
    }

    if (
      options.flags !== undefined &&
      !(await options.flags.enabled("notifications", row.memberId))
    ) {
      return "skipped";
    }

    const [target] = (await tx`
      SELECT pii.delivery_target(${intentId}, 'email') AS email
    `) as Array<{ email: string | null }>;

    if (target?.email === null || target?.email === undefined || target.email.trim() === "") {
      return "skipped";
    }

    const message = buildNotificationEmail({ row, to: target.email, options });
    await sendSmtpMail({ url: options.smtpUrl, message });
    await tx`
      UPDATE core.delivery_intents
      SET delivered_at = now()
      WHERE id = ${intentId} AND delivered_at IS NULL
    `;

    return "sent";
  });
}

export interface EmailJobsOptions extends EmailOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
}

export interface EmailJobs {
  stop(): Promise<void>;
}

/** Registers the notification email queue and its consumer. */
export async function createEmailJobs(options: EmailJobsOptions): Promise<EmailJobs> {
  await ensurePgBossQueue(options.boss, EMAIL_QUEUE);

  await options.boss.work<EmailJob>(EMAIL_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const result = await deliverNotificationEmail(options.sql, options, job.data.intentId);
      options.logger?.info("email.delivery", { intentId: job.data.intentId, result });
    }
  });

  return {
    stop: () => options.boss.offWork(EMAIL_QUEUE),
  };
}
