/**
 * The nightly capacity load test (ADR 0020, operations-observability task 3.2).
 *
 *   SEED_SIZE=large docker compose -f compose.yaml -f compose.loadtest.yaml up -d --wait
 *   bun scripts/load-test.ts --duration=300 --report=load-report.json
 *
 * Guests read cached pages (origin and CDN), members load pages plus the overlay and hold SSE
 * streams, and writers post replies at 50/s. It exits non-zero and names the failing route,
 * queue or variant budget when a threshold is missed. Sessions come from the dev-only
 * `/api/test/session` endpoint, so it only runs against development or staging stacks.
 *
 * Options (all optional): --base, --cdn, --duration (s), --warmup (s), --think (ms),
 * --threads, --guests, --cdn-guests, --members, --sse, --writes, --subs and --writer-subs
 * (comma-separated DarkAuth subjects), --metrics (comma-separated internal /metrics URLs),
 * --report (JSON output path).
 */

import { availableParallelism } from "node:os";
import { CAPACITY_WRITER_SUBS } from "@bulletin/db/seed";
import {
  CAPACITY_THRESHOLDS,
  CAPACITY_USERS,
  formatLoadReport,
  type LoadSession,
  runLoadTest,
} from "@bulletin/test-utils/load-test";
import { userOrigin } from "@bulletin/test-utils/urls";

const args = new Map(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => {
      const [name = "", value] = argument.slice(2).split("=");
      return [name, value ?? "true"] as const;
    }),
);

function count(name: string, fallback: number): number {
  const raw = args.get(name);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }

  return value;
}

const baseUrl = (args.get("base") ?? userOrigin()).replace(/\/$/, "");
const cdnUrl = (args.get("cdn") ?? `${baseUrl}/_mocks/cdn`).replace(/\/$/, "");
const origin = new URL(baseUrl).origin;
const users = {
  guests: count("guests", CAPACITY_USERS.guests),
  cdnGuests: count("cdn-guests", 200),
  members: count("members", CAPACITY_USERS.members),
  sseClients: count("sse", CAPACITY_USERS.sseClients),
  writesPerSecond: count("writes", CAPACITY_USERS.writesPerSecond),
};

async function session(sub: string): Promise<LoadSession> {
  const response = await fetch(`${baseUrl}/api/test/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ sub }),
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

  if (!response.ok || !/^(?:__Host-)?bl_session=/.test(cookie)) {
    throw new Error(
      `Could not create a load-test session for ${sub} (HTTP ${response.status}). ` +
        "The load test runs only against development or staging stacks.",
    );
  }

  return { cookie };
}

/** Collects `/<kind>/<id>-<slug>` links from a page (ADR 0001 URLs). */
async function links(path: string, kind: "forum" | "topic"): Promise<string[]> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { accept: "text/html" } });
  const html = await response.text();
  const found = new Set<string>();

  for (const match of html.matchAll(new RegExp(`href="(/${kind}/\\d+-[a-z0-9-]+)"`, "g"))) {
    if (match[1] !== undefined) {
      found.add(match[1]);
    }
  }

  return [...found];
}

const forums = (await links("/", "forum")).slice(0, 10);
const topics = [
  ...new Set((await Promise.all(forums.map((forum) => links(forum, "topic")))).flat()),
].slice(0, 50);

if (forums.length === 0 || topics.length === 0) {
  console.error(`No forums or topics found at ${baseUrl}; is the stack seeded?`);
  process.exit(2);
}

const guestPaths = ["/", ...forums, ...topics];
const replyTopicIds = topics
  .map((path) => /^\/topic\/(\d+)-/.exec(path)?.[1])
  .filter((id): id is string => id !== undefined)
  .slice(0, 20);
// Sessions belong to seeded DarkAuth subjects (several sessions per member are normal);
// virtual users share them round-robin. Writers default to the capacity seed's load writers,
// whose flood control is off, so 50 writes/s measures the write path.
const subs = (args.get("subs") ?? "member-1,member-2,member-es,member-fr,vip-member")
  .split(",")
  .filter((sub) => sub !== "");
const writerSubs = (args.get("writer-subs") ?? CAPACITY_WRITER_SUBS.join(","))
  .split(",")
  .filter((sub) => sub !== "");
const sessionCount = Math.min(200, Math.max(1, users.members, users.sseClients));
const sessions = await Promise.all(
  Array.from({ length: sessionCount }, (_, index) =>
    session(subs[index % subs.length] ?? "member-1"),
  ),
);
const writerSessions = await Promise.all(writerSubs.map((sub) => session(sub)));
const metricsUrls = (args.get("metrics") ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter((url) => url !== "");

const report = await runLoadTest(
  {
    baseUrl,
    cdnUrl,
    durationMs: count("duration", 300) * 1_000,
    warmupMs: count("warmup", 30) * 1_000,
    thinkMs: count("think", 1_000),
    users,
    guestPaths,
    memberPaths: guestPaths,
    overlayContexts: ["board", ...replyTopicIds.map((id) => `topic:${id}`)],
    sessions,
    writerSessions,
    replyTopicIds,
    threads: count("threads", Math.max(1, availableParallelism() - 1)),
    metricsUrls,
  },
  CAPACITY_THRESHOLDS,
);

console.log(formatLoadReport(report));

const reportPath = args.get("report");

if (reportPath !== undefined) {
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

process.exit(report.passed ? 0 : 1);
