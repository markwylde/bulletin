/**
 * Screenshot review tool for the UI rebuild (change `ui-rebuild`, ADR 0021).
 *
 * Captures a fixed page list for guests, a member, a moderator and staff at several viewports
 * and colour schemes, records horizontal overflow per shot, and writes a contact sheet.
 * Read-only against a running stack (BULLETIN_HTTP_PORT, default 8080).
 *
 *   bun scripts/ui-shots.ts [--out .shots/name] [--only user|staff] [--pages index,topic]
 *                           [--vp 360,768,1440] [--scheme light,dark] [--concurrency 4]
 *                           [--viewport] [--scale 2]
 *                           [--max-height 6000]
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loginAs, waitForExpression } from "@bulletin/test-utils/e2e";
import { staffOrigin, userOrigin } from "@bulletin/test-utils/urls";
import { STAFF_SECTIONS } from "../apps/staff-app/src/sections.ts";
import { composeSql } from "../tests/e2e/support/database.ts";

type Role = "guest" | "member" | "moderator" | "staff";
type Scheme = "light" | "dark";

interface Shot {
  readonly name: string;
  readonly role: Role;
  /** A path, or a resolver run in the logged-in page (for member-only discovery). */
  readonly path: string | ((view: Bun.WebView) => Promise<string | null>);
}

interface Result {
  readonly file: string;
  readonly name: string;
  readonly role: Role;
  readonly width: number;
  readonly scheme: Scheme;
  readonly overflow: number;
  readonly status: "ok" | "skipped" | "failed";
  readonly note: string;
}

const PROFILES: Readonly<Record<Exclude<Role, "guest">, string>> = {
  member: "member-1",
  moderator: "admin",
  staff: "admin",
};

const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string" },
    only: { type: "string" },
    pages: { type: "string" },
    vp: { type: "string", default: "360,768,1440" },
    scheme: { type: "string", default: "light,dark" },
    concurrency: { type: "string", default: "4" },
    "max-height": { type: "string", default: "6000" },
    /** Capture only the visible viewport (blog-ready shots) instead of the full page. */
    viewport: { type: "boolean", default: false },
    /** Device pixel ratio for the capture; 2 gives crisp images for publishing. */
    scale: { type: "string", default: "1" },
  },
});

const VIEWPORT_ONLY = args.viewport === true;
const SCALE = Number(args.scale ?? "1") || 1;
const USER = userOrigin();
const STAFF = staffOrigin();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = resolve(args.out ?? `.shots/${stamp}`);
const WIDTHS = (args.vp ?? "").split(",").filter(Boolean).map(Number);
const SCHEMES = (args.scheme ?? "").split(",").filter(Boolean) as Scheme[];
const CONCURRENCY = Math.max(1, Number(args.concurrency));
const MAX_HEIGHT = Number(args["max-height"]);
const PAGE_FILTER = args.pages === undefined ? null : new Set(args.pages.split(","));
const HEIGHTS: Readonly<Record<number, number>> = { 360: 780, 390: 844, 768: 1024, 1440: 900 };

for (const scheme of SCHEMES) {
  if (scheme !== "light" && scheme !== "dark") throw new Error(`Unknown scheme ${scheme}`);
}

async function html(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  return response.ok ? response.text() : "";
}

function links(body: string, kind: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(new RegExp(`href="(/${kind}/\\d+[^"#?]*)"`, "g"))) {
    found.add(match[1] as string);
  }
  return [...found];
}

/** Finds real forum/topic/profile paths from guest HTML so the list survives reseeding. */
async function discover(): Promise<Record<string, string | null>> {
  const index = await html(`${USER}/`);
  const forums = links(index, "forum");
  const topics: string[] = [];
  let forum: string | null = null;

  for (const candidate of forums) {
    const found = links(await html(`${USER}${candidate}`), "topic");
    if (found.length > 0 && forum === null) forum = candidate;
    topics.push(...found);
    if (topics.length >= 40) break;
  }

  let poll: string | null = null;
  let attachments: string | null = null;
  for (const topic of topics.slice(0, 40)) {
    if (poll !== null && attachments !== null) break;
    const body = await html(`${USER}${topic}`);
    if (poll === null && body.includes("data-poll")) poll = topic;
    if (attachments === null && body.includes("data-attachment")) attachments = topic;
  }

  // Seeded polls and attachments sit deep in the bulk topics; ask the stack's own database
  // (read-only, this checkout's COMPOSE_PROJECT_NAME) when the HTML scan did not reach them.
  if (poll === null || attachments === null) {
    try {
      const [pollId, attachmentId] = (
        await composeSql(
          "SELECT (SELECT topic_id FROM core.polls ORDER BY topic_id LIMIT 1), (SELECT p.topic_id FROM core.post_attachments pa JOIN core.posts p ON p.id = pa.post_id ORDER BY p.topic_id LIMIT 1)",
        )
      ).split("|");
      if (poll === null && pollId) poll = `/topic/${pollId}-poll`;
      if (attachments === null && attachmentId) attachments = `/topic/${attachmentId}-attachments`;
    } catch (error) {
      console.warn(`database discovery skipped: ${String(error).slice(0, 120)}`);
    }
  }

  const profile = links(await html(`${USER}/members`), "profile")[0] ?? null;

  return {
    forum: forum ?? forums[0] ?? null,
    topic: topics[0] ?? null,
    poll,
    attachments,
    profile,
  };
}

function shotList(found: Record<string, string | null>): Shot[] {
  const optional = (name: string, role: Role, path: string | null): Shot[] =>
    path === null ? [] : [{ name, role, path }];

  const guest: Shot[] = [
    { name: "index", role: "guest", path: "/" },
    ...optional("forum", "guest", found.forum ?? null),
    ...optional("topic", "guest", found.topic ?? null),
    ...optional("topic-poll", "guest", found.poll ?? null),
    ...optional("topic-attachments", "guest", found.attachments ?? null),
    { name: "search", role: "guest", path: "/search?q=welcome" },
    { name: "members", role: "guest", path: "/members" },
    { name: "online", role: "guest", path: "/members/online" },
    { name: "leaderboards", role: "guest", path: "/leaderboards" },
    ...optional("profile", "guest", found.profile ?? null),
    { name: "login", role: "guest", path: "/auth/login" },
    { name: "not-found", role: "guest", path: "/topic/999999999-missing" },
  ];

  const member: Shot[] = [
    { name: "m-index", role: "member", path: "/" },
    ...optional("m-topic", "member", found.topic ?? null),
    { name: "m-account", role: "member", path: "/account" },
    { name: "m-account-profile", role: "member", path: "/account/profile" },
    { name: "m-notifications", role: "member", path: "/account/notifications" },
    {
      name: "m-notification-prefs",
      role: "member",
      path: "/account/notifications/preferences",
    },
    { name: "m-privacy", role: "member", path: "/account/privacy" },
    { name: "m-attachments", role: "member", path: "/account/attachments" },
    { name: "m-follows", role: "member", path: "/account/follows" },
    { name: "m-api-keys", role: "member", path: "/account/api-keys" },
    { name: "m-warnings", role: "member", path: "/account/warnings" },
    { name: "m-conversations", role: "member", path: "/conversations" },
    {
      name: "m-conversation",
      role: "member",
      path: async (view) => {
        await view.navigate(`${USER}/conversations`);
        await settle(view);
        return view.evaluate<string | null>(
          `document.querySelector("a[data-conversation-link]")?.getAttribute("href") ?? null`,
        );
      },
    },
  ];

  const moderator: Shot[] = [
    { name: "mod-queue", role: "moderator", path: "/moderation/queue" },
    { name: "mod-reports", role: "moderator", path: "/moderation/reports" },
    { name: "mod-log", role: "moderator", path: "/moderation/log" },
  ];

  const staff: Shot[] = STAFF_SECTIONS.map((section) => ({
    name: `staff-${section.id}`,
    role: "staff" as const,
    path: section.path,
  }));

  const all = [...guest, ...member, ...moderator, ...staff].filter((shot) => {
    if (args.only === "user" && shot.role === "staff") return false;
    if (args.only === "staff" && shot.role !== "staff") return false;
    return PAGE_FILTER === null || PAGE_FILTER.has(shot.name);
  });

  return all;
}

async function settle(view: Bun.WebView): Promise<void> {
  try {
    await waitForExpression(view, "document.readyState === 'complete'", 10_000);
  } catch {
    // Screenshot whatever rendered.
  }
  // Let islands hydrate and the overlay apply.
  await Bun.sleep(700);
}

async function emulate(view: Bun.WebView, width: number, scheme: Scheme): Promise<void> {
  await view.cdp("Emulation.setEmulatedMedia", {
    media: "",
    features: [{ name: "prefers-color-scheme", value: scheme }],
  });
  await view.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: HEIGHTS[width] ?? 900,
    deviceScaleFactor: SCALE,
    mobile: width < 500,
  });
}

/** Full-page PNG, capped at --max-height so endless lists stay reviewable. */
async function capture(view: Bun.WebView, width: number, file: string): Promise<void> {
  if (VIEWPORT_ONLY) {
    const shot = await view.cdp<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await Bun.write(file, Buffer.from(shot.data, "base64"));
    return;
  }

  const height = await view.evaluate<number>(
    "Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)",
  );
  const shot = await view.cdp<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: Math.min(height, MAX_HEIGHT), scale: 1 },
  });
  await Bun.write(file, Buffer.from(shot.data, "base64"));
}

function origin(role: Role): string {
  return role === "staff" ? STAFF : USER;
}

let loginQueue: Promise<unknown> = Promise.resolve();

/**
 * Logs in one page at a time: parallel mock logins for the same profile race each other's
 * redirects. Retries once from a fresh navigation.
 */
function login(view: Bun.WebView, role: Exclude<Role, "guest">): Promise<void> {
  const attempt = async (): Promise<void> => {
    for (let tries = 0; ; tries += 1) {
      try {
        await view.navigate(`${origin(role)}/`);
        await loginAs(view, PROFILES[role]);
        return;
      } catch (error) {
        if (tries >= 1) throw error;
      }
    }
  };
  const run = loginQueue.then(attempt, attempt);
  loginQueue = run.catch(() => undefined);
  return run;
}

/** One logged-in page per role and viewport; every shot for that pair reuses it. */
async function runGroup(role: Role, width: number, shots: readonly Shot[]): Promise<Result[]> {
  const results: Result[] = [];
  const profileDirectory = await mkdtemp(join(tmpdir(), "bulletin-shots-"));
  const view = new Bun.WebView({
    backend: {
      type: "chrome",
      url: false,
      argv: process.platform === "linux" ? ["--hide-scrollbars"] : [],
    },
    width,
    height: HEIGHTS[width] ?? 900,
    dataStore: { directory: profileDirectory },
  });

  try {
    await view.navigate("about:blank");
    await emulate(view, width, SCHEMES[0] ?? "light");
    await view.navigate(`${origin(role)}/`);

    if (role !== "guest") {
      await login(view, role);
    }

    for (const shot of shots) {
      let path: string | null;
      try {
        path = typeof shot.path === "string" ? shot.path : await shot.path(view);
      } catch (error) {
        path = null;
        console.warn(`resolve ${shot.name}: ${String(error).slice(0, 120)}`);
      }

      for (const scheme of SCHEMES) {
        const file = `${shot.name}--${width}--${scheme}.png`;
        if (path === null) {
          results.push({
            file,
            name: shot.name,
            role,
            width,
            scheme,
            overflow: 0,
            status: "skipped",
            note: "not found",
          });
          continue;
        }
        try {
          await emulate(view, width, scheme);
          await view.navigate(`${origin(role)}${path}`);
          await settle(view);
          const overflow = await view.evaluate<number>(
            "Math.max(0, document.documentElement.scrollWidth - window.innerWidth)",
          );
          await capture(view, width, join(OUT, file));
          results.push({
            file,
            name: shot.name,
            role,
            width,
            scheme,
            overflow,
            status: "ok",
            note: path,
          });
        } catch (error) {
          results.push({
            file,
            name: shot.name,
            role,
            width,
            scheme,
            overflow: 0,
            status: "failed",
            note: String(error).slice(0, 160),
          });
        }
      }
    }
  } catch (error) {
    for (const shot of shots) {
      for (const scheme of SCHEMES) {
        results.push({
          file: "",
          name: shot.name,
          role,
          width,
          scheme,
          overflow: 0,
          status: "failed",
          note: `group: ${String(error).slice(0, 140)}`,
        });
      }
    }
  } finally {
    view.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }

  return results;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function contactSheet(results: readonly Result[]): string {
  const names = [...new Set(results.map((r) => r.name))];
  const rows = names
    .map((name) => {
      const cells = results
        .filter((r) => r.name === name && r.status === "ok")
        .map(
          (r) =>
            `<figure><a href="${escapeHtml(r.file)}"><img loading="lazy" src="${escapeHtml(r.file)}" style="width:${Math.round(r.width / 4)}px"></a><figcaption>${r.width} ${r.scheme}${r.overflow > 0 ? ` <b>overflow ${r.overflow}px</b>` : ""}</figcaption></figure>`,
        )
        .join("");
      return `<section><h2>${escapeHtml(name)}</h2><div class="row">${cells || "<p>no shots</p>"}</div></section>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>UI shots</title><style>
body{font:13px system-ui;margin:24px;background:#f4f4f5;color:#18181b}
.row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0}img{border:1px solid #d4d4d8;display:block;background:#fff}
figcaption{margin-top:4px;color:#52525b}b{color:#b91c1c}h2{font-size:15px;margin:28px 0 8px}
</style><h1>UI shots</h1>${rows}`;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const found = await discover();
  console.log("discovered", found);
  const shots = shotList(found);

  const groups: Array<{ role: Role; width: number; shots: Shot[] }> = [];
  for (const role of ["guest", "member", "moderator", "staff"] as const) {
    const forRole = shots.filter((s) => s.role === role);
    if (forRole.length === 0) continue;
    for (const width of WIDTHS) groups.push({ role, width, shots: forRole });
  }

  const results: Result[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
    while (next < groups.length) {
      const group = groups[next++] as (typeof groups)[number];
      const done = await runGroup(group.role, group.width, group.shots);
      results.push(...done);
      console.log(
        `done ${group.role} @${group.width}: ${done.filter((r) => r.status === "ok").length}/${done.length}`,
      );
    }
  });
  await Promise.all(workers);
  Bun.WebView.closeAll();

  results.sort(
    (a, b) => a.name.localeCompare(b.name) || a.width - b.width || a.scheme.localeCompare(b.scheme),
  );
  await Bun.write(join(OUT, "index.html"), contactSheet(results));
  await Bun.write(join(OUT, "results.json"), JSON.stringify(results, null, 2));

  const problems = results.filter((r) => r.status !== "ok" || r.overflow > 0);
  console.table(
    problems.map((r) => ({
      shot: r.name,
      width: r.width,
      scheme: r.scheme,
      status: r.status,
      overflow: r.overflow,
      note: r.note,
    })),
  );
  const ok = results.filter((r) => r.status === "ok").length;
  console.log(
    `${ok}/${results.length} shots, ${results.filter((r) => r.overflow > 0).length} with overflow → ${join(OUT, "index.html")}`,
  );
}

await main();
