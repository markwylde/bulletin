import { ensurePgBossQueue } from "@bulletin/db/events";
import {
  createUnsubscribeToken,
  digestItems,
  pendingDigestDeliveries,
  queueDigests,
  sendSmtpMail,
} from "@bulletin/domain/notifications";
import { canonicalUrl } from "@bulletin/domain/urls";
import { createServerT, isLocale, type Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { type EmailOptions, WORKER_CATALOGS } from "./email.ts";
import type { WorkerFlags } from "./flags.ts";

export const DIGEST_DAILY_QUEUE = "digest.daily";
export const DIGEST_WEEKLY_QUEUE = "digest.weekly";
export const DIGEST_EMAIL_QUEUE = "digest.email";
/** 07:00 every day, and 07:00 on Monday for the weekly cadence (ADR 0011). */
export const DIGEST_DAILY_CRON = "0 7 * * *";
export const DIGEST_WEEKLY_CRON = "0 7 * * 1";
export const DIGEST_UNSUBSCRIBE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface DigestEmailJob {
  readonly intentId: string;
  readonly deliveryId: string;
}

interface DigestRow {
  readonly id: string;
  readonly member_id: string;
  readonly frequency: "daily" | "weekly";
  readonly period_start: Date | string;
  readonly period_end: Date | string;
  readonly locale: string | null;
  readonly recipient_name: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function localeOf(value: string | null): Locale {
  return value !== null && isLocale(value) ? value : "en";
}

function digestIntro(
  translate: ReturnType<typeof createServerT>,
  frequency: "daily" | "weekly",
): string {
  return frequency === "daily"
    ? translate("digest.intro.daily", {})
    : translate("digest.intro.weekly", {});
}

function digestSubject(
  translate: ReturnType<typeof createServerT>,
  frequency: "daily" | "weekly",
): string {
  return frequency === "daily"
    ? translate("digest.subject.daily", {})
    : translate("digest.subject.weekly", {});
}

/**
 * Builds and sends one digest. The content is rebuilt here with current permissions, so a forum
 * the member lost access to since the window disappears (digests spec, ADR 0011).
 */
export async function deliverDigestEmail(
  sql: SQL,
  options: EmailOptions,
  job: DigestEmailJob,
): Promise<"sent" | "skipped"> {
  return sql.begin(async (tx): Promise<"sent" | "skipped"> => {
    const [row] = (await tx`
      SELECT
        d.id::text AS id,
        d.member_id::text AS member_id,
        d.frequency,
        d.period_start,
        d.period_end,
        m.locale,
        m.display_name AS recipient_name,
        (SELECT delivered_at FROM core.delivery_intents WHERE id = ${job.intentId}) AS delivered_at
      FROM core.digest_deliveries d
      JOIN core.members m ON m.id = d.member_id
      WHERE d.id = ${job.deliveryId}
    `) as Array<DigestRow & { delivered_at: Date | null }>;

    if (row === undefined || row.delivered_at !== null) {
      return "skipped";
    }

    const finish = async (): Promise<void> => {
      await tx`
        UPDATE core.delivery_intents
        SET delivered_at = now()
        WHERE id = ${job.intentId} AND delivered_at IS NULL
      `;
      await tx`
        UPDATE core.digest_subscriptions
        SET last_sent_at = GREATEST(coalesce(last_sent_at, ${row.period_end}), ${row.period_end}),
            updated_at = now()
        WHERE member_id = ${row.member_id}
      `;
    };

    if (options.flags !== undefined && !(await options.flags.enabled("digests", row.member_id))) {
      await finish();
      return "skipped";
    }

    const [target] = (await tx`
      SELECT pii.delivery_target(${job.intentId}, 'email') AS email
    `) as Array<{ email: string | null }>;

    if (target?.email === null || target?.email === undefined || target.email.trim() === "") {
      await finish();
      return "skipped";
    }

    const locale = localeOf(row.locale);
    const translate = createServerT(locale, { shipped: WORKER_CATALOGS });
    const items = await digestItems(tx, row.member_id, {
      since: new Date(row.period_start),
      until: new Date(row.period_end),
      limit: 20,
    });

    if (items.length === 0) {
      await finish();
      return "skipped";
    }

    const greeting = translate("digest.greeting", {
      name: row.recipient_name ?? translate("email.fallbackName", {}),
    });
    const intro = digestIntro(translate, row.frequency);
    const token = createUnsubscribeToken(options.unsubscribeSecret, {
      memberId: row.member_id,
      type: "digest",
      expiresAt: Date.now() + DIGEST_UNSUBSCRIBE_TTL_MS,
    });
    const pageUrl = `${options.userOrigin}/unsubscribe?token=${encodeURIComponent(token)}`;
    const oneClickUrl = `${options.userOrigin}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
    const lines = [greeting, "", intro];

    for (const item of items) {
      const url = `${options.userOrigin}${canonicalUrl(
        "topic",
        item.topicId,
        item.slug,
        item.postId === null ? {} : { postId: item.postId },
      )}`;
      lines.push(translate("digest.item", { title: item.title, url }));
    }

    lines.push("", translate("digest.unsubscribe", { url: pageUrl }));
    const text = lines.join("\n");
    const html = `<!doctype html><html><body><p>${escapeHtml(greeting)}</p><p>${escapeHtml(
      intro,
    )}</p><ul>${items
      .map((item) => {
        const url = `${options.userOrigin}${canonicalUrl(
          "topic",
          item.topicId,
          item.slug,
          item.postId === null ? {} : { postId: item.postId },
        )}`;
        return `<li><a href="${escapeHtml(url)}">${escapeHtml(item.title)}</a></li>`;
      })
      .join("")}</ul><p><a href="${escapeHtml(pageUrl)}">${escapeHtml(
      translate("digest.unsubscribe", { url: pageUrl }),
    )}</a></p></body></html>`;

    await sendSmtpMail({
      url: options.smtpUrl,
      message: {
        from: options.mailFrom,
        to: target.email,
        subject: digestSubject(translate, row.frequency),
        text,
        html,
        headers: {
          "List-Unsubscribe": `<${oneClickUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      },
    });

    await finish();
    return "sent";
  });
}

export interface DigestJobsOptions extends EmailOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly flags?: WorkerFlags;
}

export interface DigestJobs {
  stop(): Promise<void>;
}

/** Registers the two cron runs and the per-member digest email queue. */
export async function createDigestJobs(options: DigestJobsOptions): Promise<DigestJobs> {
  await ensurePgBossQueue(options.boss, DIGEST_DAILY_QUEUE);
  await ensurePgBossQueue(options.boss, DIGEST_WEEKLY_QUEUE);
  await ensurePgBossQueue(options.boss, DIGEST_EMAIL_QUEUE);

  for (const [queue, frequency] of [
    [DIGEST_DAILY_QUEUE, "daily"],
    [DIGEST_WEEKLY_QUEUE, "weekly"],
  ] as const) {
    await options.boss.work(queue, async () => {
      const queued = await queueDigests(options.sql, frequency, {
        ...(options.flags === undefined
          ? {}
          : {
              isEnabled: async (memberId: string) =>
                options.flags === undefined ? true : options.flags.enabled("digests", memberId),
            }),
      });
      // Recover deliveries whose enqueue was lost after the delivery/intent committed.
      const pending = await pendingDigestDeliveries(options.sql);
      const deliveries = new Map(
        [...queued, ...pending].map((digest) => [
          digest.deliveryId,
          { intentId: digest.intentId, deliveryId: digest.deliveryId },
        ]),
      );
      options.logger?.info("digest.queued", {
        frequency,
        members: queued.length,
        recovered: pending.length,
      });

      for (const digest of deliveries.values()) {
        await options.boss.send(DIGEST_EMAIL_QUEUE, digest, {
          singletonKey: `digest:${digest.deliveryId}`,
        });
      }
    });
  }

  await options.boss.work<DigestEmailJob>(DIGEST_EMAIL_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const result = await deliverDigestEmail(options.sql, options, job.data);
      options.logger?.info("digest.delivery", { deliveryId: job.data.deliveryId, result });
    }
  });

  await options.boss.schedule(DIGEST_DAILY_QUEUE, DIGEST_DAILY_CRON, {});
  await options.boss.schedule(DIGEST_WEEKLY_QUEUE, DIGEST_WEEKLY_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(DIGEST_EMAIL_QUEUE);
      await options.boss.offWork(DIGEST_WEEKLY_QUEUE);
      await options.boss.offWork(DIGEST_DAILY_QUEUE);
    },
  };
}
