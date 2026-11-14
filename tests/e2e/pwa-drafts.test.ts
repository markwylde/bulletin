import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
  withPages,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl, userBaseUrl } from "@bulletin/test-utils/urls";
import { setFlagRules } from "./support/flags.ts";
import { restorePostingFlood, setPostingFloodSeconds } from "./support/group-settings.ts";
import { createPagedTopic } from "./support/paged-topic.ts";

// Run against the full stack:
//   docker compose up -d --build --wait
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const STAFF_URL = staffBaseUrl();

const OFFLINE_ERRORS = [
  /ERR_INTERNET_DISCONNECTED/,
  /Failed to fetch/,
  /Failed to fetch dynamically imported module/,
  /Failed to load resource/,
  /net::ERR/,
];

const IDB_SEED = `(value) => new Promise((resolve, reject) => {
  const request = indexedDB.open("bulletin-offline", 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains("drafts")) {
      request.result.createObjectStore("drafts", { keyPath: "id" });
    }
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    const transaction = database.transaction("drafts", "readwrite");
    transaction.objectStore("drafts").put(value);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error);
  };
})`;

const IDB_COUNT = `() => new Promise((resolve, reject) => {
  const request = indexedDB.open("bulletin-offline", 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains("drafts")) {
      request.result.createObjectStore("drafts", { keyPath: "id" });
    }
  };
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const database = request.result;
    const transaction = database.transaction("drafts", "readonly");
    const all = transaction.objectStore("drafts").getAll();
    all.onsuccess = () => resolve(all.result.length);
    all.onerror = () => reject(all.error);
  };
})`;

async function openReplyEditor(view: Bun.WebView, topicUrl: string): Promise<void> {
  await view.navigate(topicUrl);
  await waitForSelector(view, "[data-reply-toggle]", 20_000);
  await clickSelector(view, "[data-reply-toggle]");
  await waitForSelector(view, "[data-reply-form] [data-editor-ready='true']", 20_000);
  // Let the WYSIWYG chunk finish loading; going offline mid-import is not what this test is about.
  await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
  await waitForSelector(view, '[data-editor-mode="source"]', 20_000);
  await clickSelector(view, '[data-editor-mode="source"]');
  await waitForSelector(view, "[data-editor-source]", 20_000);
}

async function seedDraft(view: Bun.WebView, memberId: string): Promise<void> {
  const seeded = await view.evaluate<boolean>(`(${IDB_SEED})({
    id: "e2e-draft",
    memberId: ${JSON.stringify(memberId)},
    contextKey: "reply:topic:1",
    url: "/api/topics/1/replies",
    body: JSON.stringify({ bodyMd: "private text" }),
    createdAt: new Date().toISOString(),
  })`);
  expect(seeded).toBe(true);
}

async function draftCount(view: Bun.WebView): Promise<number> {
  return view.evaluate<number>(`(${IDB_COUNT})()`);
}

interface AttachedTarget {
  readonly sessionId?: string;
  readonly targetInfo?: { readonly type?: string; readonly url?: string };
}

/** Chrome's page-target emulation does not cover the service worker's own fetches. */
async function offlineController(view: Bun.WebView): Promise<(offline: boolean) => Promise<void>> {
  const sessions = new Set<string>();

  view.addEventListener<AttachedTarget>("Target.attachedToTarget", (event) => {
    const info = event.data.targetInfo;

    if (
      event.data.sessionId !== undefined &&
      info?.type === "service_worker" &&
      (info.url ?? "").includes("bulletin.localhost")
    ) {
      sessions.add(event.data.sessionId);
    }
  });
  await view.cdp("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  await Bun.sleep(250);
  await view.cdp("Network.enable");

  return async (offline: boolean): Promise<void> => {
    const conditions = {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    };

    await view.cdp("Network.setCacheDisabled", { cacheDisabled: true });
    await view.cdp("Network.emulateNetworkConditions", conditions);

    for (const sessionId of sessions) {
      await view.cdp("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: 1, method: "Network.enable", params: {} }),
      });
      await view.cdp("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 2,
          method: "Network.emulateNetworkConditions",
          params: conditions,
        }),
      });
    }
  };
}

integrationDescribe("offline drafts", () => {
  beforeAll(() => setPostingFloodSeconds(0));
  afterAll(restorePostingFlood);

  test("queues a reply offline, offers it on reconnect and posts it after confirmation", async () => {
    const body = `Offline reply ${Date.now()}`;

    await withPage(
      { url: USER_URL, viewport: "mobile360", allowConsoleErrors: OFFLINE_ERRORS },
      async (view) => {
        await loginAs(view, "member-1");
        const fixture = await createPagedTopic(view, {
          forumId: "5",
          title: `Offline fixture ${Date.now()}`,
          replies: 0,
        });
        await openReplyEditor(view, new URL(fixture.url, USER_URL).toString());
        await setInputValue(view, "[data-editor-source]", body);

        await view.cdp("Network.enable");
        await view.cdp("Network.emulateNetworkConditions", {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });

        await waitForSelector(view, "[data-reply-submit]:not([disabled])");
        await clickSelector(view, "[data-reply-submit]");
        await waitForSelector(view, "[data-offline-drafts]:not([hidden])", 20_000);
        await waitForText(view, "You're offline", 20_000);
        expect(await view.evaluate<string>("document.documentElement.dataset.memberId")).toMatch(
          /^\d+$/,
        );

        await waitForExpression(view, `(${IDB_COUNT})().then((count) => count === 1)`, 10_000);

        await view.cdp("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });

        await waitForSelector(view, "[data-offline-drafts-send]:not([disabled])", 20_000);
        await clickSelector(view, "[data-offline-drafts-send]");
        await waitForSelector(view, "[data-topic-page]", 30_000);
        await waitForText(view, body, 20_000);
        await waitForExpression(view, `(${IDB_COUNT})().then((count) => count === 0)`, 10_000);
      },
    );
  }, 180_000);

  test("a revoked session clears the offline queue and local drafts", async () => {
    await withPages(
      {
        user: {
          url: USER_URL,
          viewport: "mobile360",
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
        staff: {
          url: STAFF_URL,
          viewport: "desktop",
          allowConsoleErrors: [/ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
        },
      },
      async ({ user, staff }) => {
        if (user === undefined || staff === undefined) {
          throw new Error("Missing pages");
        }

        await loginAs(user, "member-1");
        await waitForExpression(user, 'document.documentElement.dataset.stream === "open"', 20_000);
        const memberId = await user.evaluate<string>(
          'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json()).then((body) => body.memberId)',
        );
        expect(memberId).toMatch(/^\d+$/);
        await seedDraft(user, memberId);
        expect(await draftCount(user)).toBe(1);

        await user.evaluate(`localStorage.setItem(
          "bulletin:draft:reauth:${memberId}:reply:topic:1",
          JSON.stringify({ bodyMd: "private text" })
        )`);

        await loginAs(staff, "admin");
        await waitForSelector(staff, '[data-auth-state="authenticated"]');

        const status = await staff.evaluate<number>(`(async () => {
          const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json());
          const response = await fetch("/api/staff/members/${memberId}/sessions/revoke", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
            body: "{}"
          });
          return response.status;
        })()`);
        expect(status).toBe(200);

        await waitForExpression(
          user,
          'document.documentElement.dataset.visitor === "guest"',
          30_000,
        );
        expect(
          await user.evaluate<number>(
            'Object.keys(localStorage).filter((key) => key.startsWith("bulletin:draft:")).length',
          ),
        ).toBe(0);
        expect(await draftCount(user)).toBe(0);
      },
    );
  }, 300_000);

  test("re-auth keeps the offline queue and the editor's local draft", async () => {
    const body = `Kept through re-auth ${Date.now()}`;

    await withPage(
      {
        url: USER_URL,
        viewport: "mobile360",
        allowConsoleErrors: [/401.*\/api\//, /ERR_INCOMPLETE_CHUNKED_ENCODING.*\/api\/stream/],
      },
      async (view) => {
        await loginAs(view, "member-1");
        const fixture = await createPagedTopic(view, {
          forumId: "5",
          title: `Reauth fixture ${Date.now()}`,
          replies: 0,
        });
        await openReplyEditor(view, new URL(fixture.url, USER_URL).toString());
        await setInputValue(view, "[data-editor-source]", body);

        const session = await view.evaluate<{ memberId: string; csrfToken: string }>(
          'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json())',
        );
        await seedDraft(view, session.memberId);

        const aged = await view.evaluate<boolean>(
          `fetch("/api/test/age-reauth", {
            method: "POST",
            headers: { "x-bulletin-csrf": ${JSON.stringify(session.csrfToken)} },
          }).then((response) => response.ok)`,
        );
        expect(aged).toBe(true);

        await waitForExpression(
          view,
          'document.documentElement.dataset.stream === "reauth"',
          20_000,
        );
        await waitForExpression(
          view,
          `Object.keys(localStorage).some((key) => key.startsWith("bulletin:draft:reauth:"))`,
          20_000,
        );
        await waitForSelector(view, "[data-stream-reauth]:not([hidden])", 20_000);

        // A background submit now gets 401 reauth_required; the text must stay on the device.
        await waitForSelector(view, "[data-reply-submit]:not([disabled])");
        await clickSelector(view, "[data-reply-submit]");
        await waitForSelector(view, "[data-stream-reauth]:not([hidden])", 20_000);

        expect(await draftCount(view)).toBe(1);
        expect(
          await view.evaluate<number>(
            'Object.keys(localStorage).filter((key) => key.startsWith("bulletin:draft:reauth:")).length',
          ),
        ).toBeGreaterThan(0);
      },
    );
  }, 180_000);

  test("does not write an offline draft when the pwa flag is off", async () => {
    const topicUrl = new URL("/topic/3-what-are-you-reading-this-month", USER_URL).toString();
    const offRules = [{ type: "group", groups: ["members"], value: false }];

    try {
      await setFlagRules("pwa", offRules);

      await withPage(
        { url: USER_URL, viewport: "mobile360", allowConsoleErrors: OFFLINE_ERRORS },
        async (view) => {
          await loginAs(view, "member-1");
          await view.navigate(topicUrl);
          expect(
            await view.evaluate<boolean>(
              `document.documentElement.dataset.clientFlags?.includes('"pwa":true') ?? false`,
            ),
          ).toBe(false);
          expect(
            await view.evaluate<number>(
              "document.querySelectorAll('[data-offline-drafts]').length",
            ),
          ).toBe(0);

          await waitForSelector(view, "[data-reply-toggle]", 20_000);
          await clickSelector(view, "[data-reply-toggle]");
          await waitForSelector(view, "[data-reply-form] [data-editor-ready='true']", 20_000);
          await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
          await waitForSelector(view, '[data-editor-mode="source"]', 20_000);
          await clickSelector(view, '[data-editor-mode="source"]');
          await waitForSelector(view, "[data-editor-source]", 20_000);
          await setInputValue(view, "[data-editor-source]", `Should not queue ${Date.now()}`);

          await view.cdp("Network.enable");
          await view.cdp("Network.emulateNetworkConditions", {
            offline: true,
            latency: 0,
            downloadThroughput: 0,
            uploadThroughput: 0,
          });

          await waitForSelector(view, "[data-reply-submit]:not([disabled])");
          await clickSelector(view, "[data-reply-submit]");
          await waitForSelector(view, "[data-reply-form] [data-form-error]:not([hidden])", 20_000);
          expect(await draftCount(view)).toBe(0);
        },
      );
    } finally {
      await setFlagRules("pwa", []);
    }
  }, 300_000);
  test("clears member drafts on a later guest visit after revocation", async () => {
    const profile = await mkdtemp(join(tmpdir(), "bulletin-pwa-revoke-"));
    let memberId = "";

    try {
      await withPage(
        { url: USER_URL, viewport: "mobile360", profileDirectory: profile },
        async (view) => {
          await loginAs(view, "member-1");
          memberId = await view.evaluate<string>(
            'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json()).then((body) => body.memberId)',
          );
          await seedDraft(view, memberId);
          await view.evaluate(`localStorage.setItem(
            "bulletin:draft:reauth:${memberId}:reply:topic:1",
            JSON.stringify({ bodyMd: "private text" })
          )`);
        },
      );

      await withPage({ url: STAFF_URL, viewport: "desktop" }, async (view) => {
        await loginAs(view, "admin");
        const status = await view.evaluate<number>(`(async () => {
          const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json());
          const response = await fetch("/api/staff/members/${memberId}/sessions/revoke", {
            method: "POST",
            headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
            body: "{}"
          });
          return response.status;
        })()`);
        expect(status).toBe(200);
      });

      // A fresh visit with the same profile is a guest page with no editor or index script.
      await withPage(
        { url: `${USER_URL}/members`, viewport: "mobile360", profileDirectory: profile },
        async (view) => {
          await waitForExpression(
            view,
            'document.documentElement.dataset.visitor === "guest"',
            20_000,
          );
          await waitForExpression(view, `(${IDB_COUNT})().then((count) => count === 0)`, 20_000);
          expect(
            await view.evaluate<number>(
              'Object.keys(localStorage).filter((key) => key.startsWith("bulletin:draft:")).length',
            ),
          ).toBe(0);
        },
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }, 300_000);

  test("clears the previous member's drafts when the account switches on another page", async () => {
    const profile = await mkdtemp(join(tmpdir(), "bulletin-pwa-switch-"));
    let firstMember = "";

    try {
      await withPage(
        { url: USER_URL, viewport: "mobile360", profileDirectory: profile },
        async (view) => {
          await loginAs(view, "member-1");
          firstMember = await view.evaluate<string>(
            'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json()).then((body) => body.memberId)',
          );
          await seedDraft(view, firstMember);
          await view.evaluate(`localStorage.setItem(
            "bulletin:draft:reauth:${firstMember}:reply:topic:1",
            JSON.stringify({ bodyMd: "private text" })
          )`);
        },
      );

      await withPage(
        { url: USER_URL, viewport: "mobile360", profileDirectory: profile },
        async (view) => {
          const switched = await view.evaluate<string | null>(`(async () => {
            const response = await fetch("/api/test/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sub: "member-2" })
            });
            if (!response.ok) return null;
            const body = await response.json();
            return typeof body.memberId === "string" ? body.memberId : null;
          })()`);

          if (switched === null || switched === firstMember) {
            throw new Error("Could not switch to member-2");
          }

          await view.navigate(`${USER_URL}/members`);
          await waitForExpression(
            view,
            `document.documentElement.dataset.memberId === ${JSON.stringify(switched)}`,
            20_000,
          );
          await waitForExpression(view, `(${IDB_COUNT})().then((count) => count === 0)`, 20_000);
          expect(
            await view.evaluate<number>(
              'Object.keys(localStorage).filter((key) => key.startsWith("bulletin:draft:reauth:")).length',
            ),
          ).toBe(0);
        },
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }, 300_000);

  test("keeps reauth drafts during the auth handoff and clears them on a guest page", async () => {
    const draftKey = "bulletin:draft:reauth:11:reply:topic:1";

    await withPage({ url: `${USER_URL}/auth/login`, viewport: "mobile360" }, async (view) => {
      await view.evaluate(
        `localStorage.setItem(${JSON.stringify(draftKey)}, JSON.stringify({ bodyMd: "kept" }))`,
      );
      await view.navigate(`${USER_URL}/auth/login?handoff=1`);
      expect(
        await view.evaluate<boolean>(`localStorage.getItem(${JSON.stringify(draftKey)}) !== null`),
      ).toBe(true);

      await view.navigate(USER_URL);
      await waitForExpression(
        view,
        `localStorage.getItem(${JSON.stringify(draftKey)}) === null`,
        20_000,
      );
    });
  }, 180_000);
  test("an offline shell installed as a guest cannot clear a member's queued draft", async () => {
    const topicUrl = new URL("/topic/3-what-are-you-reading-this-month", USER_URL).toString();
    const body = `Guest shell draft ${Date.now()}`;

    await withPage(
      { url: USER_URL, viewport: "mobile360", allowConsoleErrors: OFFLINE_ERRORS },
      async (view) => {
        // Install/cache the shell while the browser is still a guest, then sign in.
        await waitForExpression(
          view,
          "navigator.serviceWorker.ready.then((registration) => registration.active !== null)",
          30_000,
        );
        await loginAs(view, "member-1");
        const setOffline = await offlineController(view);

        await view.navigate(topicUrl);
        await waitForSelector(view, "[data-reply-toggle]", 20_000);
        await clickSelector(view, "[data-reply-toggle]");
        await waitForSelector(view, "[data-reply-form] [data-editor-ready='true']", 20_000);
        await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
        await waitForSelector(view, '[data-editor-mode="source"]', 20_000);
        await clickSelector(view, '[data-editor-mode="source"]');
        await waitForSelector(view, "[data-editor-source]", 20_000);
        await setInputValue(view, "[data-editor-source]", body);

        await setOffline(true);
        await waitForSelector(view, "[data-reply-submit]:not([disabled])");
        await clickSelector(view, "[data-reply-submit]");
        await waitForSelector(view, "[data-offline-drafts]:not([hidden])", 20_000);
        await waitForExpression(view, `(${IDB_COUNT})().then((count) => count === 1)`, 10_000);

        // Opening the cached guest shell offline must not treat its identity as authoritative.
        await view.navigate(`${topicUrl}?offline=${Date.now()}`);
        await waitForSelector(view, "[data-offline-page]", 20_000);
        expect(await view.evaluate<boolean>("navigator.onLine")).toBe(false);
        expect(await draftCount(view)).toBe(1);

        await setOffline(false);
      },
    );
  }, 300_000);
  test("shows the reauth prompt when realtime is disabled", async () => {
    const offRules = [{ type: "group", groups: ["members"], value: false }];

    try {
      await setFlagRules("realtime", offRules);

      await withPage(
        {
          url: USER_URL,
          viewport: "mobile360",
          allowConsoleErrors: [/401.*\/api\//],
        },
        async (view) => {
          await loginAs(view, "member-1");
          await view.navigate(
            new URL("/topic/3-what-are-you-reading-this-month", USER_URL).toString(),
          );
          await waitForSelector(view, "[data-reply-toggle]", 20_000);
          await clickSelector(view, "[data-reply-toggle]");
          await waitForSelector(view, "[data-reply-form] [data-editor-ready='true']", 20_000);
          await waitForSelector(view, "[data-editor-wysiwyg] .ProseMirror", 30_000);
          await waitForSelector(view, '[data-editor-mode="source"]', 20_000);
          await clickSelector(view, '[data-editor-mode="source"]');
          await waitForSelector(view, "[data-editor-source]", 20_000);
          await setInputValue(view, "[data-editor-source]", `Needs reauth ${Date.now()}`);

          const session = await view.evaluate<{ csrfToken: string }>(
            'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json())',
          );
          const aged = await view.evaluate<boolean>(
            `fetch("/api/test/age-reauth", {
            method: "POST",
            headers: { "x-bulletin-csrf": ${JSON.stringify(session.csrfToken)} },
          }).then((response) => response.ok)`,
          );
          expect(aged).toBe(true);

          await waitForSelector(view, "[data-reply-submit]:not([disabled])");
          await clickSelector(view, "[data-reply-submit]");
          await waitForSelector(view, "[data-stream-reauth]:not([hidden])", 20_000);
          expect(
            await view.evaluate<string>(
              'document.querySelector("[data-stream-reauth-continue]")?.getAttribute("href") ?? ""',
            ),
          ).toContain("/api/auth/refresh");
        },
      );
    } finally {
      await setFlagRules("realtime", []);
    }
  }, 300_000);
});
