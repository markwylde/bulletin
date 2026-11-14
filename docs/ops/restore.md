# Backups and restore runbook

This runbook covers backing up a Bulletin deployment and restoring it. It follows ADR 0020 (operations) and ADR 0012 (privacy). Postgres is the only stateful service besides object storage. The database is authoritative, so after a restore the files are brought back into line with it.

Recovery window: **35 days** for both the database and object storage.

## 1. What must be in place before you need it

### Postgres: point-in-time recovery

Set up continuous WAL archiving plus nightly base backups. That lets you restore to any second in the last 35 days.

**Managed Postgres** (RDS, Cloud SQL, Azure, Crunchy Bridge and similar):

- Turn on automated backups with **35-day retention** and point-in-time recovery.
- Use the provider's "restore to point in time" to create a **new** instance. Then point the services at it (section 3). Never restore over the live instance.

**Self-hosted with pgBackRest:**

```ini
# /etc/pgbackrest/pgbackrest.conf
[global]
repo1-type=s3
repo1-s3-bucket=bulletin-pg-backups
repo1-s3-endpoint=s3.eu-west-1.amazonaws.com
repo1-s3-region=eu-west-1
repo1-path=/bulletin
repo1-retention-full-type=time
repo1-retention-full=35
start-fast=y

[bulletin]
pg1-path=/var/lib/postgresql/17/main
```

```ini
# postgresql.conf
archive_mode = on
archive_command = 'pgbackrest --stanza=bulletin archive-push %p'
wal_level = replica
```

- Run a full backup nightly: `pgbackrest --stanza=bulletin --type=full backup`.
- Run `pgbackrest --stanza=bulletin check` from monitoring every day. Alert when it fails or when the newest backup is more than 26 hours old.
- Keep the backup repository in a different account or project from production, with deletion protection on.

### Object storage: versioning

Turn on **bucket versioning** with a lifecycle rule that expires noncurrent versions and delete markers **35 days** after they stop being current:

```json
{
  "Rules": [
    {
      "ID": "bulletin-35-day-versions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 35 },
      "Expiration": { "ExpiredObjectDeleteMarker": true }
    }
  ]
}
```

The local S3 mock behaves the same way: overwritten and deleted objects keep their previous versions for 35 days. Override this with `S3_NONCURRENT_VERSION_DAYS` only in tests.

The bucket also holds two operational prefixes. **Never** put lifecycle rules or manual deletes on them:

| Key | Written by | Purpose |
|---|---|---|
| `journal/<date>/<request>.json` | the erasure job | The erasure journal (ADR 0012): IDs and timestamps of every completed erasure, with the sessions, API keys and push devices it revoked. It sits outside the database rollback set. |
| `journal/<date>/rev-<time>-<id>.json` | workers, every 2 seconds | Batches of standalone revocations: sessions revoked or deleted (logouts included), API keys revoked or deleted, push devices removed or re-assigned to another member. IDs only. Database triggers record each change, whatever code path made it. |
| `ops/watermark.json` | workers, every minute | The outbox sequence the database has reached. A database behind it has been restored. |

## 2. What happens automatically after a restore

When workers start against a restored database, they work through these steps **before they report ready or start any job**:

1. **Detect the restore.** The outbox sequence `core.events_id_seq` is behind `ops/watermark.json`. Sequences only go backwards through a restore.
2. **Replay the journal.** Every entry under `journal/` that is missing from `core.erasure_journal_applied` is replayed through `pii.replay_erasure`:
   - The erasure request is recreated if the restore point predates it.
   - The sessions, API keys and push devices named in the entry are revoked again.
   - The normal erasure job then runs to completion.
   Revocation batches are replayed through `pii.replay_revocations`: the sessions and API keys they name are revoked again, and the push devices are removed (the browser subscribes again).
   No email, push or webhook can reach an erased member, because delivery jobs only start after this step.
3. **Reconcile storage.** Objects that no database row references are deleted (ADR 0019 reconciliation; uploads from the last 15 minutes are spared).
4. **List missing objects.** Ready attachments and current avatars whose object is gone are written to `core.missing_objects`. They appear in the staff app under **Overview → Missing files**. Downloading such an attachment returns `410 attachment_missing` with a readable message.
5. Record the run in `core.restore_runs` and move the watermark to the restored timeline.

Steps 2 to 4 also run on **every** workers start, even when no restore is detected. The watermark is written once a minute, so a backup taken after its latest write restores to a sequence equal to or ahead of it. Such a restore is not detected or recorded in `core.restore_runs`, but erasures are still replayed, orphaned objects removed and missing files listed. The workers log `restore.startup_reconciled` when that run changed anything.

Meanwhile **user-api, user-app (through user-api) and staff-api fail `/health/ready`**. Their `journal` check passes only once **every** entry under `journal/` is in `core.erasure_journal_applied`. Entries complete in any order (an erasure accepted earlier can finish later), so no single "newest entry" pointer is trusted. Load balancers therefore send no traffic until erasures and revocations are re-applied. A proxy that keeps routing anyway gets nothing either: every request except `/health/*` is answered with `503`, `Cache-Control: no-store` and `Retry-After: 30`, so a restored session or API key of an erased member is never served.

A replay that fails, for example because plugin-host is not up yet, is retried with backoff. The board stays unready in the meantime. Watch the workers' logs for `restore.startup_failed`.

## 3. Restoring the database (step by step)

1. **Declare the incident** and pick the target time, in UTC. Write it down.
2. **Stop writes.** Scale `user-api`, `staff-api`, `workers` and `plugin-host` to zero, and set the CDN to serve stale content or an outage page. `user-app` can keep serving cached guest pages until step 5.
3. **Restore Postgres to the target time:**
   - Managed: restore to a point in time as a new instance named `bulletin-restore-<date>`.
   - pgBackRest, on a fresh data directory:

     ```sh
     pgbackrest --stanza=bulletin --delta \
       --type=time --target="2026-11-13 09:00:00+00" --target-action=promote restore
     ```

4. **Do not restore object storage.** Files deleted after the target time are not needed. Files the restored database still references are recovered one by one (section 4).
5. **Point the services at the restored database** (`DATABASE_URL`, `LISTEN_DATABASE_URL`, `PG_BOSS_DATABASE_URL`, `MIGRATION_DATABASE_URL`). Start **workers first**, then the other services.
6. **Wait for readiness.** Workers log `restore.completed` with the number of erasures replayed, objects removed and objects missing. Every service's `/health/ready` should then return 200.
7. **Check:**
   - In the staff app, **Overview → System health** shows every service ready and no lagging queue.
   - **Overview → Missing files** shows the last post-restore run as completed.
   - Content from just before the target time is visible, and nothing after it is.
8. **Purge the whole CDN** with the provider's purge-all. The CDN may hold pages rendered after the target time.
9. Re-enable traffic.

To re-run the post-restore sequence by hand (for example after fixing a failed replay), run this:

```sh
# inside a workers container/pod
bun apps/workers/src/post-restore.ts
```

## 4. Recovering a deleted or overwritten file

Previous versions are kept for 35 days. For each row listed under **Missing files**, run this:

```sh
# newest previous version of the key
bun apps/workers/src/post-restore.ts --restore-object=att/<sha256>
# or a specific version
bun apps/workers/src/post-restore.ts --restore-object=att/<sha256> --version=<versionId>
```

This does a server-side copy of the old version onto the same key. Then run `bun apps/workers/src/post-restore.ts` again, or wait for the next restore run. Recovered files drop off the list.

The provider console works too: show versions, select the version before the delete marker, and restore or copy it.

If no version is left (deleted more than 35 days ago), tell the member that the attachment was lost. The row stays listed until staff delete the post or attachment.

## 5. The restore drill

Run the drill **nightly in CI** against a disposable compose stack (`.github/workflows/nightly.yml`, job `restore-drill`), and **at least quarterly in staging** by an operator.

Local or CI:

```sh
docker compose up -d --build --wait
bun scripts/restore-drill.ts --report=restore-drill.json
```

The drill:

1. takes a backup with object storage excluded;
2. writes a marker reply;
3. stops the app services and restores the backup over the database;
4. starts them again;
5. checks that the workers detected the restore and completed the post-restore run;
6. smoke tests the board, and checks that the marker reply is gone.

It exits non-zero and names the failing step.

Staging (quarterly), restoring to a point from yesterday:

```sh
BULLETIN_DRILL_BASE_URL=https://staging.example.org \
BULLETIN_DRILL_RESTORE_COMMAND='./ops/staging-pitr.sh "$TARGET_TIME"' \
BULLETIN_DRILL_POST_RESTORE_COMMAND='kubectl exec deploy/workers -- bun apps/workers/src/post-restore.ts' \
bun scripts/restore-drill.ts --mode=staging --report=drill-$(date +%F).json
```

`--target` defaults to 24 hours ago. File the JSON report with the quarter's operations review, and record how long the board took to report ready (the recovery time).

## 6. Journal retention

Workers prune journal entries older than 36 days (the 35-day recovery window plus a day), together with their rows in `core.erasure_journal_applied`. No restore can need an older entry: its effect is already in any backup the window allows. A revocation reaches the journal within a few seconds, so only one made in the last seconds before the database was lost can be missing from it.
