/**
 * Post-restore operations (ADR 0020; operations-observability tasks 4.2 and 4.4), run inside
 * the workers image after a database restore:
 *
 *   bun apps/workers/src/post-restore.ts              # replay, reconcile, scan (manual run)
 *   bun apps/workers/src/post-restore.ts --watermark  # record the outbox watermark now
 *   bun apps/workers/src/post-restore.ts --restore-object=<key> [--version=<id>]
 *
 * Workers also run the full sequence by themselves at startup when they detect a restore; this
 * command is for runbooks and the drill. `--restore-object` makes the newest previous version
 * of a deleted or overwritten object current again (bucket versioning, 35 days).
 */

import { createCdnPurger } from "@bulletin/cache";
import { createLogger, loadConfig, loadStorageEnvironment } from "@bulletin/config";
import { createServiceSql } from "@bulletin/config/server";
import { runPostRestore, writeRestoreWatermark } from "@bulletin/db/jobs";
import { createStorage } from "@bulletin/storage";

const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [name = "", ...value] = argument.slice(2).split("=");
      return [name, value.length === 0 ? "true" : value.join("=")] as const;
    }),
);

const config = loadConfig();
const logger = createLogger({ service: "workers", level: config.logLevel });
const storage = createStorage(loadStorageEnvironment(Bun.env, config.nodeEnv));

async function restoreObject(key: string, versionId: string | undefined): Promise<number> {
  if (storage.listVersions === undefined || storage.restoreVersion === undefined) {
    console.error("This storage client does not support object versions");
    return 2;
  }

  const versions = (await storage.listVersions(key)).filter((version) => version.key === key);
  const target =
    versionId === undefined
      ? versions.find((version) => !version.isLatest && !version.deleteMarker)
      : versions.find((version) => version.versionId === versionId && !version.deleteMarker);

  if (target === undefined) {
    console.error(`No previous version of ${key} is available (versions expire after 35 days)`);
    return 1;
  }

  await storage.restoreVersion(key, target.versionId);
  console.log(
    JSON.stringify({ restored: key, versionId: target.versionId, from: target.lastModified }),
  );
  return 0;
}

let exitCode = 0;
const objectKey = args.get("restore-object");

if (objectKey !== undefined) {
  exitCode = await restoreObject(objectKey, args.get("version"));
} else {
  const sql = createServiceSql("workers", config.databaseUrl);

  try {
    if (args.has("watermark")) {
      await writeRestoreWatermark(sql, storage);
      console.log(JSON.stringify({ watermark: "written" }));
    } else {
      const purgeUrl = Bun.env.BULLETIN_CDN_PURGE_URL;
      const result = await runPostRestore({
        sql,
        storage,
        logger,
        trigger: "manual",
        erasure: {
          pluginHostUrl: Bun.env.PLUGIN_HOST_INTERNAL_URL ?? "http://plugin-host:3004",
          pluginToken: Bun.env.PLUGIN_INTERNAL_TOKEN ?? "bulletin-development-only-internal-token",
          ...(purgeUrl === undefined ? {} : { purge: createCdnPurger({ url: purgeUrl }) }),
          logger,
        },
      });
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    await sql.close();
  }
}

process.exit(exitCode);
