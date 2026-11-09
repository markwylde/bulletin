import { describe, expect, test } from "bun:test";
import { fetchBoardState, shouldBlockBoard } from "./board-client.ts";

const VALID = {
  boardName: "Bulletin",
  boardDescription: "A forum",
  defaultLocale: "en",
  offline: true,
  offlineMessage: "Down",
  canViewOffline: false,
};

function fakeFetch(response: () => Promise<Response>): typeof fetch {
  return (async () => response()) as unknown as typeof fetch;
}

describe("board client gate", () => {
  test("treats a non-200 response as unknown and blocked", async () => {
    const state = await fetchBoardState(
      fakeFetch(async () => new Response("nope", { status: 503 })),
    );

    expect(state).toBeNull();
    expect(shouldBlockBoard(state)).toBe(true);
  });

  test("treats a network failure as unknown and blocked", async () => {
    const state = await fetchBoardState(
      fakeFetch(async () => {
        throw new TypeError("network down");
      }),
    );

    expect(state).toBeNull();
    expect(shouldBlockBoard(state)).toBe(true);
  });

  test("treats malformed JSON as unknown and blocked", async () => {
    const state = await fetchBoardState(fakeFetch(async () => Response.json({ unexpected: true })));

    expect(state).toBeNull();
    expect(shouldBlockBoard(state)).toBe(true);
  });

  test("parses a valid board response", async () => {
    const state = await fetchBoardState(fakeFetch(async () => Response.json(VALID)));

    expect(state).toEqual(VALID);
  });

  test("blocks offline unless the viewer may bypass it", () => {
    expect(shouldBlockBoard(null)).toBe(true);
    expect(shouldBlockBoard({ ...VALID, offline: false })).toBe(false);
    expect(shouldBlockBoard({ ...VALID, offline: true, canViewOffline: false })).toBe(true);
    expect(shouldBlockBoard({ ...VALID, offline: true, canViewOffline: true })).toBe(false);
  });
});
