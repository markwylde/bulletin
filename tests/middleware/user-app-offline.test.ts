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

mock.module("../../apps/user-app/src/db.ts", () => ({
  readSql: () => ({}),
  closeReadSql: async () => undefined,
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
