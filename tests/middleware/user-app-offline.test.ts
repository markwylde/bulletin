import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

interface FakeBoard {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: "en" | "es" | "fr";
  readonly offline: boolean;
  readonly offlineMessage: string;
}

let board: FakeBoard = {
  boardName: "Bulletin",
  boardDescription: "",
  defaultLocale: "en",
  offline: true,
  offlineMessage: "Down for maintenance",
};
let boardFails = false;
let canViewOffline = false;
let nextCalls = 0;

mock.module("astro:middleware", () => ({
  defineMiddleware: (handler: unknown) => handler,
}));

mock.module("../../apps/user-app/src/board.ts", () => ({
  readBoard: async () => {
    if (boardFails) {
      throw new Error("board state unavailable");
    }

    return board;
  },
  canViewOffline: async () => canViewOffline,
}));

const fakeSql = (() => Promise.resolve([])) as unknown;
mock.module("../../apps/user-app/src/db.ts", () => ({
  READ_POOL_MAX: 1,
  readSql: () => fakeSql,
  closeReadSql: async () => undefined,
}));

// No journal entries: the board was never restored, so the restore gate is open. A test that
// needs a restore in progress lists an entry the (empty) database has not applied.
let journalEntry: string | null = null;
mock.module("../../apps/user-app/src/storage.ts", () => ({
  storage: {
    list: async () =>
      journalEntry === null ? [] : [{ key: journalEntry, size: 1, lastModified: new Date() }],
  },
}));

const { onRequest } = (await import("../../apps/user-app/src/middleware.ts")) as {
  onRequest: (context: unknown, next: () => Promise<Response>) => Promise<Response>;
};

function createContext(path = "/", headers: Record<string, string> = {}): unknown {
  return {
    url: new URL(`http://bulletin.test${path}`),
    request: new Request(`http://bulletin.test${path}`, { headers }),
    locals: {},
    redirect: (location: string, status = 302) =>
      new Response(null, { status, headers: { location } }),
  };
}

function next(): Promise<Response> {
  nextCalls += 1;
  return Promise.resolve(
    new Response("<html><body>forum</body></html>", {
      headers: { "content-type": "text/html" },
    }),
  );
}

beforeEach(() => {
  board = {
    boardName: "Bulletin",
    boardDescription: "",
    defaultLocale: "en",
    offline: true,
    offlineMessage: "Down for maintenance",
  };
  boardFails = false;
  canViewOffline = false;
  nextCalls = 0;
});

// Runs first: once the journal has been applied, the gate stays open for the process.
describe("user-app restore gate", () => {
  test("refuses pages and APIs until the erasure journal is applied, then opens", async () => {
    journalEntry = "journal/2026-11-14/000000000042.json";

    const page = await onRequest(
      createContext("/topic/12-welcome", {
        accept: "text/html",
        cookie: "bl_session=restored; bp=fr.1.light",
      }),
      next,
    );
    expect(page.status).toBe(503);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("retry-after")).toBe("30");
    expect(await page.text()).toBe(
      "Le forum est en cours de restauration depuis une sauvegarde et sera de retour dans quelques minutes.",
    );

    const api = await onRequest(createContext("/api/me/overlay"), next);
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ code: "restoring" });
    expect(nextCalls).toBe(0);

    const live = await onRequest(createContext("/health/live"), next);
    expect(live.status).toBe(200);

    // The replay finished (nothing unapplied); the closed result is reused for a second.
    journalEntry = null;
    await Bun.sleep(1_100);
    board.offline = false;
    const served = await onRequest(createContext("/"), next);
    expect(served.status).toBe(200);
    expect(nextCalls).toBe(1);
  });
});

describe("user-app offline middleware", () => {
  test("blocks a page request without navigation headers", async () => {
    const response = await onRequest(createContext("/"), next);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("data-offline");
    expect(nextCalls).toBe(0);
  });

  test("blocks a request that carries no Sec-Fetch-Mode header at all", async () => {
    const response = await onRequest(createContext("/topic/12-welcome"), next);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("data-offline-login");
    expect(nextCalls).toBe(0);
  });

  test("fails closed when the board state cannot be read", async () => {
    boardFails = true;
    const response = await onRequest(createContext("/", { "sec-fetch-mode": "navigate" }), next);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain("data-offline");
    expect(nextCalls).toBe(0);
  });

  test("serves the page when the board is online", async () => {
    board = { ...board, offline: false };
    const response = await onRequest(createContext("/"), next);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("forum");
    expect(nextCalls).toBe(1);
  });

  test("does not gate API paths on the forum page state", async () => {
    const response = await onRequest(createContext("/api/board"), next);

    expect(response.status).toBe(200);
    expect(nextCalls).toBe(1);
  });

  test("keeps the sign-in page available while offline", async () => {
    const response = await onRequest(createContext("/auth/login"), next);

    expect(response.status).toBe(200);
    expect(nextCalls).toBe(1);
  });
});

afterAll(() => {
  mock.restore();
});
