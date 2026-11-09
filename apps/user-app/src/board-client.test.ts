import { describe, expect, test } from "bun:test";
import { applyBoardDefaultLocale, fetchBoardState, shouldBlockBoard } from "./board-client.ts";

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

function documentFor(options: {
  readonly cookie?: string;
  readonly search?: string;
  readonly source?: "member" | "guest";
  readonly lang?: string;
}): { readonly doc: Document; readonly applied: string[] } {
  const applied: string[] = [];
  const doc = {
    documentElement: {
      lang: options.lang ?? "en",
      dataset: { localeSource: options.source ?? "guest" },
    },
    cookie: options.cookie ?? "",
    defaultView: {
      location: { search: options.search ?? "" },
      __bulletinApplyLocale: (locale: string) => applied.push(locale),
    },
  } as unknown as Document;

  return { doc, applied };
}

describe("board default locale", () => {
  test("uses the board default for a fresh guest", () => {
    const { doc, applied } = documentFor({});

    applyBoardDefaultLocale(doc, { ...VALID, defaultLocale: "es" });

    expect(applied).toEqual(["es"]);
  });

  test("does not override a member preference", () => {
    const { doc, applied } = documentFor({ source: "member" });

    applyBoardDefaultLocale(doc, { ...VALID, defaultLocale: "es" });

    expect(applied).toEqual([]);
  });

  test("keeps a valid guest cookie or query locale", () => {
    const cookieDoc = documentFor({ cookie: "bp=fr.1.light" });
    const queryDoc = documentFor({ search: "?lang=en" });

    applyBoardDefaultLocale(cookieDoc.doc, { ...VALID, defaultLocale: "es" });
    applyBoardDefaultLocale(queryDoc.doc, { ...VALID, defaultLocale: "es" });

    expect(cookieDoc.applied).toEqual([]);
    expect(queryDoc.applied).toEqual([]);
  });

  test("ignores an invalid cookie or query and falls back to the board default", () => {
    const cookieDoc = documentFor({ cookie: "bp=garbage" });
    const queryDoc = documentFor({ search: "?lang=de" });

    applyBoardDefaultLocale(cookieDoc.doc, { ...VALID, defaultLocale: "fr" });
    applyBoardDefaultLocale(queryDoc.doc, { ...VALID, defaultLocale: "fr" });

    expect(cookieDoc.applied).toEqual(["fr"]);
    expect(queryDoc.applied).toEqual(["fr"]);
  });
});
