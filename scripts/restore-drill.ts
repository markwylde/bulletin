/**
 * The restore drill (ADR 0020; operations-observability task 4.3; runbook in
 * docs/ops/restore.md).
 *
 * Local mode (default; nightly CI, against a disposable compose stack that is already up):
 *
 *   bun scripts/restore-drill.ts [--report=restore-drill.json]
 *
 *   1. takes a logical backup of the database (object storage is outside the backup, as in
 *      production where the bucket is versioned separately),
 *   2. writes a marker reply after the backup,
 *   3. stops the app services and restores the backup over the live database,
 *   4. starts them again: workers detect the restore, replay the erasure journal, reconcile
 *      storage and list missing files before anything reports ready,
 *   5. smoke tests the board and checks the marker is gone (content as of the backup).
 *
 * Staging mode (quarterly, by an operator; the restore itself is provider-specific):
 *
 *   BULLETIN_DRILL_BASE_URL=https://staging.example \
 *   BULLETIN_DRILL_RESTORE_COMMAND='./ops/pitr-restore.sh "$TARGET_TIME"' \
 *   BULLETIN_DRILL_POST_RESTORE_COMMAND='kubectl exec deploy/workers -- bun apps/workers/src/post-restore.ts' \
 *   bun scripts/restore-drill.ts --mode=staging [--target=2026-11-13T09:00:00Z]
 *
 * It restores to `--target` (default: 24 hours ago), waits for readiness, runs the post-restore
 * command and the smoke tests, and reports pass or fail.
 */

import { userOrigin } from "@bulletin/test-utils/urls";

const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [name = "", ...value] = argument.slice(2).split("=");
      return [name, value.length === 0 ? "true" : value.join("=")] as const;
    }),
);

interface DrillStep {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail?: string;
}

const steps: DrillStep[] = [];
const mode = args.get("mode") ?? "local";
const compose = (Bun.env.BULLETIN_COMPOSE ?? "docker compose").split(" ");
const APP_SERVICES = ["user-app", "user-api", "staff-api", "workers", "plugin-host"];
const DUMP_PATH = "/tmp/bulletin-restore-drill.dump";
const DROP_SCHEMAS_SQL = [
  "DO $drill$ DECLARE s text; BEGIN",
  "FOR s IN SELECT nspname FROM pg_namespace",
  "WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'public', 'mock_s3')",
  "LOOP EXECUTE format('DROP SCHEMA %I CASCADE', s); END LOOP; END $drill$;",
].join(" ");

class DrillFailure extends Error {}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();

  try {
    const result = await run();
    steps.push({
      name,
      ok: true,
      ms: Math.round(performance.now() - started),
      ...(typeof result === "string" && result !== "" ? { detail: result.slice(0, 500) } : {}),
    });
    console.log(`ok   ${name}`);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push({ name, ok: false, ms: Math.round(performance.now() - started), detail });
    console.log(`FAIL ${name}: ${detail}`);
    throw new DrillFailure(name);
  }
}

async function run(command: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const process = Bun.spawn([...command], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (code !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${code}: ${(stderr || stdout).trim().slice(-800)}`,
    );
  }

  return stdout.trim();
}

function shell(command: string, env: Record<string, string> = {}): Promise<string> {
  return run(["sh", "-c", command], env);
}

function composeRun(...command: string[]): Promise<string> {
  return run([...compose, ...command]);
}

function psql(query: string): Promise<string> {
  return composeRun(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "bulletin",
    "-d",
    "bulletin",
    "-tA",
    "-c",
    query,
  );
}

async function waitForReady(baseUrl: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(5_000),
      });
      last = `${response.status} ${await response.text()}`;

      if (response.ok) {
        return last;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    await Bun.sleep(2_000);
  }

  throw new Error(`not ready after ${timeoutMs / 1_000} s: ${last}`);
}

async function smoke(baseUrl: string): Promise<{ readonly topicPath: string }> {
  const home = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } });

  if (!home.ok) {
    throw new Error(`home page answered ${home.status}`);
  }

  const html = await home.text();
  const forums = [
    ...new Set([...html.matchAll(/href="(\/forum\/\d+-[a-z0-9-]+)"/g)].map((m) => m[1])),
  ];

  if (forums.length === 0) {
    throw new Error("the home page lists no forums");
  }

  // Categories list forums only; take the first forum that lists a topic.
  let topicPath: string | undefined;

  for (const forum of forums) {
    const forumPage = await fetch(`${baseUrl}${forum}`, { headers: { accept: "text/html" } });

    if (!forumPage.ok) {
      throw new Error(`forum ${forum} answered ${forumPage.status}`);
    }

    topicPath = /href="(\/topic\/\d+-[a-z0-9-]+)"/.exec(await forumPage.text())?.[1];

    if (topicPath !== undefined) {
      break;
    }
  }

  if (topicPath === undefined) {
    throw new Error(`none of ${forums.length} forums lists a topic`);
  }

  const topic = await fetch(`${baseUrl}${topicPath}`, { headers: { accept: "text/html" } });

  if (!topic.ok) {
    throw new Error(`topic ${topicPath} answered ${topic.status}`);
  }

  return { topicPath };
}

async function topicHtml(baseUrl: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { accept: "text/html", "cache-control": "no-cache" },
  });
  return response.text();
}

async function postMarker(baseUrl: string, topicPath: string, marker: string): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const sessionResponse = await fetch(`${baseUrl}/api/test/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ sub: "member-1" }),
  });
  const cookie = (sessionResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  if (!sessionResponse.ok || cookie === "") {
    throw new Error(`could not create a drill session (HTTP ${sessionResponse.status})`);
  }

  const session = (await (
    await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } })
  ).json()) as { csrfToken?: string };
  const topicId = /^\/topic\/(\d+)-/.exec(topicPath)?.[1] ?? "";
  const reply = await fetch(`${baseUrl}/api/topics/${topicId}/replies`, {
    method: "POST",
    headers: {
      cookie,
      origin,
      "content-type": "application/json",
      "x-bulletin-csrf": session.csrfToken ?? "",
    },
    body: JSON.stringify({ bodyMd: marker }),
  });

  if (!reply.ok) {
    throw new Error(`marker reply answered ${reply.status}: ${await reply.text()}`);
  }
}

async function localDrill(baseUrl: string): Promise<void> {
  await step("stack is ready", () => waitForReady(baseUrl, 60_000));
  const { topicPath } = await step("smoke test before the backup", () => smoke(baseUrl));
  await step("record the outbox watermark", () =>
    composeRun("exec", "-T", "workers", "bun", "apps/workers/src/post-restore.ts", "--watermark"),
  );
  await step("back up the database (object storage excluded)", () =>
    composeRun(
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "bulletin",
      "-d",
      "bulletin",
      "-Fc",
      "--exclude-schema=mock_s3",
      "-f",
      DUMP_PATH,
    ),
  );
  const restoreRunsBefore = Number(
    await step("count restore runs", () => psql("SELECT count(*) FROM core.restore_runs")),
  );

  const marker = `Restore drill marker ${crypto.randomUUID()}`;
  await step("write a reply after the backup", async () => {
    await postMarker(baseUrl, topicPath, marker);
    const deadline = Date.now() + 30_000;

    while (!(await topicHtml(baseUrl, topicPath)).includes(marker)) {
      if (Date.now() > deadline) {
        throw new Error("the marker reply never appeared");
      }

      await Bun.sleep(500);
    }
  });
  await step("record the outbox watermark after the change", () =>
    composeRun("exec", "-T", "workers", "bun", "apps/workers/src/post-restore.ts", "--watermark"),
  );

  await step("stop the app services", () => composeRun("stop", ...APP_SERVICES));
  await step("restore the backup over the database", () =>
    // Drop the database's schemas (not the S3 mock's, which stands in for the bucket) and
    // replay the dump, all in one transaction: a failed restore leaves the database as it was.
    composeRun(
      "exec",
      "-T",
      "-e",
      `DRILL_DROP_SQL=${DROP_SCHEMAS_SQL}`,
      "postgres",
      "sh",
      "-c",
      `{ printf '%s\n' "$DRILL_DROP_SQL"; pg_restore -f - ${DUMP_PATH}; } | ` +
        "psql -q -U bulletin -d bulletin -v ON_ERROR_STOP=1 --single-transaction",
    ),
  );
  await step("start the app services", () => composeRun("start", ...APP_SERVICES));
  await step("board reports ready after the restore", () => waitForReady(baseUrl, 300_000));
  await step("workers detected the restore and ran the post-restore sequence", async () => {
    const row = await psql(
      "SELECT trigger || ':' || status FROM core.restore_runs ORDER BY id DESC LIMIT 1",
    );
    const count = Number(await psql("SELECT count(*) FROM core.restore_runs"));

    if (row !== "detected:completed" || count <= restoreRunsBefore) {
      throw new Error(
        `latest restore run is "${row}" (${count} runs, ${restoreRunsBefore} before)`,
      );
    }

    return row;
  });
  await step("smoke test after the restore", () => smoke(baseUrl));
  await step("content is as of the backup (the marker is gone)", async () => {
    if ((await topicHtml(baseUrl, topicPath)).includes(marker)) {
      throw new Error("the reply written after the backup is still shown");
    }
  });
  await step("remove the drill dump", () =>
    composeRun("exec", "-T", "postgres", "rm", "-f", DUMP_PATH),
  );
}

async function stagingDrill(): Promise<void> {
  const baseUrl = Bun.env.BULLETIN_DRILL_BASE_URL;
  const restore = Bun.env.BULLETIN_DRILL_RESTORE_COMMAND;

  if (baseUrl === undefined || restore === undefined) {
    throw new Error(
      "staging mode needs BULLETIN_DRILL_BASE_URL and BULLETIN_DRILL_RESTORE_COMMAND",
    );
  }

  const target = args.get("target") ?? new Date(Date.now() - 86_400_000).toISOString();
  await step("staging is ready", () => waitForReady(baseUrl, 60_000));
  await step(`restore to ${target}`, () => shell(restore, { TARGET_TIME: target }));
  await step("board reports ready after the restore", () => waitForReady(baseUrl, 1_800_000));

  const postRestore = Bun.env.BULLETIN_DRILL_POST_RESTORE_COMMAND;

  if (postRestore !== undefined) {
    await step("post-restore run (replay, reconcile, scan)", () => shell(postRestore));
  }

  await step("smoke test after the restore", () => smoke(baseUrl));
}

const startedAt = new Date().toISOString();
let passed = true;

try {
  if (mode === "staging") {
    await stagingDrill();
  } else {
    await localDrill((args.get("base") ?? userOrigin()).replace(/\/$/, ""));
  }
} catch (error) {
  passed = false;

  if (!(error instanceof DrillFailure)) {
    steps.push({
      name: "drill",
      ok: false,
      ms: 0,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.log(`FAIL drill: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const report = { mode, startedAt, finishedAt: new Date().toISOString(), passed, steps };
console.log(`restore drill (${mode}): ${passed ? "PASS" : "FAIL"}`);

const reportPath = args.get("report");

if (reportPath !== undefined) {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

process.exit(passed ? 0 : 1);
