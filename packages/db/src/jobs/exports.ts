import type { Logger } from "@bulletin/config";
import {
  buildMemberExport,
  type PluginExportResult,
  readPrivacySettings,
} from "@bulletin/domain/privacy";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Export jobs are queued immediately after the member's request is committed. */
export const EXPORT_QUEUE = "privacy.export";

export interface ExportJobOptions {
  /** Optional test seam; the worker defaults to the plugin-host internal endpoint. */
  readonly pluginExport?: (
    pluginId: string,
    memberId: string,
  ) => Promise<{
    readonly ok: boolean;
    readonly data?: unknown;
    readonly error?: string;
  }>;
  readonly pluginHostUrl?: string;
  readonly pluginToken?: string;
  readonly enqueueEmail?: (intentId: string) => Promise<void>;
  readonly logger?: Logger;
}

export interface ExportResult {
  readonly requestId: string;
  readonly memberId: string;
  readonly exportKey: string;
  readonly sizeBytes: number;
  readonly files: readonly string[];
  readonly pluginFailures: readonly string[];
}

function withPluginRetries(
  loader: (pluginId: string, memberId: string) => Promise<PluginExportResult>,
): (pluginId: string, memberId: string) => Promise<PluginExportResult> {
  return async (pluginId, memberId) => {
    let last: PluginExportResult = { ok: false, error: "plugin export failed" };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await loader(pluginId, memberId);

      if (last.ok) {
        return last;
      }
    }

    return last;
  };
}

function pluginExporter(
  options: ExportJobOptions,
): (pluginId: string, memberId: string) => Promise<PluginExportResult> {
  if (options.pluginExport !== undefined) {
    return withPluginRetries(options.pluginExport);
  }

  return withPluginRetries(async (pluginId: string, memberId: string) => {
    if (options.pluginHostUrl === undefined || options.pluginToken === undefined) {
      return { ok: false, error: "plugin host is not configured" };
    }

    try {
      const response = await fetch(`${options.pluginHostUrl}/internal/gdpr`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.pluginToken}`,
        },
        body: JSON.stringify({ pluginId, operation: "export", memberId }),
      });
      const body = (await response.json().catch(() => null)) as {
        readonly ok?: unknown;
        readonly data?: unknown;
        readonly error?: unknown;
      } | null;
      return {
        ok: response.ok && body?.ok === true,
        ...(body?.data === undefined ? {} : { data: body.data }),
        ...(typeof body?.error === "string"
          ? { error: body.error }
          : response.ok
            ? {}
            : { error: `plugin host answered ${response.status}` }),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Builds, uploads and announces one export request. */
export async function runExportJob(
  sql: SQL,
  storage: StorageClient,
  requestId: string,
  options: ExportJobOptions = {},
): Promise<ExportResult | null> {
  const [started] = (await sql`
    SELECT pii.begin_export(${requestId}) AS member_id
  `) as Array<{ member_id: string | null }>;

  if (started?.member_id === null || started?.member_id === undefined) {
    const [intent] = (await sql`
      SELECT pii.export_email_intent(${requestId}) AS id
    `) as Array<{ id: string | null }>;

    if (intent?.id !== null && intent?.id !== undefined && options.enqueueEmail !== undefined) {
      await options.enqueueEmail(intent.id);
    }

    return null;
  }

  const memberId = started.member_id;
  const candidateKey = `export/${crypto.randomUUID()}.zip`;
  const [reserved] = (await sql`
    SELECT pii.reserve_export_key(${requestId}, ${candidateKey}) AS export_key
  `) as Array<{ export_key: string | null }>;

  if (reserved?.export_key === null || reserved?.export_key === undefined) {
    return null;
  }

  const exportKey = reserved.export_key;
  const settings = await readPrivacySettings(sql);
  let bundle: Awaited<ReturnType<typeof buildMemberExport>>;

  try {
    bundle = await buildMemberExport(sql, storage, requestId, {
      pluginExport: pluginExporter(options),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`SELECT pii.export_failed(${requestId}, ${message})`;
    throw error;
  }

  const expiresAt = new Date(Date.now() + settings.exportDays * 24 * 60 * 60 * 1_000);
  let sizeBytes: number;

  try {
    sizeBytes =
      storage.putFile === undefined
        ? await storage.put(exportKey, await Bun.file(bundle.path).bytes(), {
            contentType: "application/zip",
          })
        : await storage.putFile(exportKey, bundle.path, { contentType: "application/zip" });
  } finally {
    await bundle.cleanup();
  }
  const intentId = await sql.begin(async (tx) => {
    const [completed] = (await tx`
      SELECT pii.complete_export(${requestId}, ${exportKey}, ${expiresAt}) AS completed
    `) as Array<{ completed: boolean }>;

    if (completed?.completed !== true) {
      return null;
    }

    const [notification] = (await tx`
      INSERT INTO core.notifications (member_id, type, data_request_id)
      VALUES (${memberId}, 'data.export.ready', ${requestId})
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (notification === undefined) {
      return null;
    }

    const [intent] = (await tx`
      INSERT INTO core.delivery_intents (member_id, kind, ref_id, channel)
      VALUES (${memberId}, 'notification', ${notification.id}, 'email')
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    return intent?.id ?? null;
  });

  if (intentId === null) {
    await storage.delete(exportKey).catch(() => undefined);
    return null;
  }

  if (options.enqueueEmail !== undefined) {
    await options.enqueueEmail(intentId);
  }

  options.logger?.info("privacy.export.completed", {
    requestId,
    memberId,
    exportKey,
    sizeBytes,
    pluginFailures: bundle.pluginFailures.length,
  });

  return {
    requestId,
    memberId,
    exportKey,
    sizeBytes,
    files: bundle.files,
    pluginFailures: bundle.pluginFailures,
  };
}

export interface ExportJobData {
  readonly requestId: string;
}

export interface ExportJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly storage: StorageClient;
  readonly pluginHostUrl?: string;
  readonly pluginToken?: string;
  readonly enqueueEmail?: (intentId: string) => Promise<void>;
  readonly logger?: Logger;
}

export interface ExportJobs {
  stop(): Promise<void>;
}

export async function createExportJobs(options: ExportJobsOptions): Promise<ExportJobs> {
  await ensurePgBossQueue(options.boss, EXPORT_QUEUE);

  await options.boss.work<ExportJobData>(EXPORT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const result = await runExportJob(options.sql, options.storage, job.data.requestId, {
        ...(options.pluginHostUrl === undefined ? {} : { pluginHostUrl: options.pluginHostUrl }),
        ...(options.pluginToken === undefined ? {} : { pluginToken: options.pluginToken }),
        ...(options.enqueueEmail === undefined ? {} : { enqueueEmail: options.enqueueEmail }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });

      if (result === null) {
        options.logger?.info("privacy.export.skipped", { requestId: job.data.requestId });
      }
    }
  });

  return {
    stop: () => options.boss.offWork(EXPORT_QUEUE),
  };
}
