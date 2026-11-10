import { describe, expect, test } from "bun:test";
import { userOrigin } from "@bulletin/test-utils/urls";

// Task 6.1/6.3/6.4: the HTTP cache contract, the CDN mock and the JSON endpoints, against
// the running stack:
//   docker compose up -d
//   BULLETIN_INTEGRATION=1 bun run test:integration

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const stackDescribe = ENABLED ? describe : describe.skip;
const ORIGIN = userOrigin();
const CDN = `${ORIGIN}/_mocks/cdn`;

async function purge(keys: readonly string[]): Promise<void> {
  const response = await fetch(`${CDN}/purge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys }),
  });

  expect(response.status).toBe(200);
}

stackDescribe("HTTP cache contract", () => {
  test("a guest demo page carries the public CDN policy, surrogate keys and dev headers", async () => {
    const response = await fetch(`${ORIGIN}/_demo/2`);
    const etag = response.headers.get("etag");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=15",
    );
    // The demo header/footer carry the board name, so the page also depends on `board`.
    expect(response.headers.get("surrogate-key")).toBe("forum:2 board");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(["HIT", "MISS", "BYPASS"]).toContain(response.headers.get("x-cache"));
    expect(response.headers.get("x-cache-key")).toBeString();
  });

  test("the home page is guest-cacheable on the board tag and answers 304", async () => {
    const response = await fetch(`${ORIGIN}/`);
    const etag = response.headers.get("etag");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=15, stale-while-revalidate=15",
    );
    expect(response.headers.get("surrogate-key")).toBe("board");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(["HIT", "MISS", "BYPASS"]).toContain(response.headers.get("x-cache"));
    expect(response.headers.get("x-cache-key")).toBeString();

    const conditional = await fetch(`${ORIGIN}/`, {
      headers: { "if-none-match": etag ?? "" },
    });

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);

    // Any session cookie makes the response private, exactly like the demo route.
    const privateHome = await fetch(`${ORIGIN}/`, {
      headers: { cookie: "bl_session=not-a-valid-session" },
    });

    expect(privateHome.headers.get("cache-control")).toBe("private, no-store");
    expect(privateHome.headers.get("surrogate-key")).toBeNull();
  });

  test("a guest ETag never satisfies a member's revalidation", async () => {
    const guest = await fetch(`${ORIGIN}/_demo/2`);
    const guestEtag = guest.headers.get("etag");
    const guestHtml = await guest.text();

    expect(guestHtml).toContain('data-visitor="guest"');

    const session = await fetch(`${ORIGIN}/api/test/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ sub: "member-1" }),
    });
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    expect(session.status).toBe(200);
    expect(cookie).toMatch(/^(?:__Host-)?bl_session=/);

    // Revalidating with the guest's ETag must return the member shell, not a 304 that keeps
    // the guest's `data-visitor` and skips the overlay.
    const revalidated = await fetch(`${ORIGIN}/_demo/2`, {
      headers: { cookie, "if-none-match": guestEtag ?? "" },
    });

    expect(revalidated.status).toBe(200);
    expect(await revalidated.text()).toContain('data-visitor="member"');
    expect(revalidated.headers.get("etag")).not.toBe(guestEtag);
  });

  test("a request with any session cookie stays private", async () => {
    const response = await fetch(`${ORIGIN}/_demo/2`, {
      headers: { cookie: "bl_session=not-a-valid-session" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("surrogate-key")).toBeNull();
  });

  test("a matching If-None-Match is a 304 and a different variant is not", async () => {
    const first = await fetch(`${ORIGIN}/_demo/2`);
    const etag = first.headers.get("etag");

    expect(etag).not.toBeNull();

    const conditional = await fetch(`${ORIGIN}/_demo/2`, {
      headers: { "if-none-match": etag ?? "" },
    });

    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("etag")).toBe(etag);

    const otherVariant = await fetch(`${ORIGIN}/_demo/1`, {
      headers: { "if-none-match": etag ?? "" },
    });

    expect(otherVariant.status).toBe(200);
    expect(otherVariant.headers.get("etag")).not.toBe(etag);
  });

  test("the CDN serves a guest page from cache and only varies by bp", async () => {
    await purge(["forum:2"]);

    const first = await fetch(`${CDN}/_demo/2`);
    const second = await fetch(`${CDN}/_demo/2`);

    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(second.headers.get("surrogate-key")).toBe("forum:2 board");

    const spanish = await fetch(`${CDN}/_demo/2`, {
      headers: { cookie: "bp=es.1.system" },
    });
    const french = await fetch(`${CDN}/_demo/2`, {
      headers: { cookie: "bp=fr.1.system" },
    });
    const spanishAgain = await fetch(`${CDN}/_demo/2`, {
      headers: { cookie: "bp=es.1.system" },
    });

    expect(spanish.headers.get("x-cache")).not.toBe("HIT");
    expect(french.headers.get("x-cache")).not.toBe("HIT");
    expect(spanishAgain.headers.get("x-cache")).toBe("HIT");

    expect(await spanish.text()).toContain('lang="es"');
    expect(await french.text()).toContain('lang="fr"');

    const key = spanish.headers.get("x-cache-key") ?? "";
    expect(key).toContain("bp=es.1.system");
    expect(spanish.headers.get("x-cache-key")).not.toBe(french.headers.get("x-cache-key"));
  });

  test("the CDN bypasses a member request", async () => {
    const response = await fetch(`${CDN}/_demo/2`, {
      headers: { cookie: "bl_session=fake" },
    });

    expect(response.headers.get("x-cache")).toBe("BYPASS");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

async function resetRateBuckets(): Promise<void> {
  const response = await fetch(`${ORIGIN}/api/test/reset-rate-buckets`, {
    method: "POST",
    headers: { origin: ORIGIN },
  });

  expect(response.status).toBe(200);
}

stackDescribe("beacon and overlay endpoints", () => {
  test("the guest beacon sets a pseudonymous cookie and records the visit", async () => {
    await resetRateBuckets();

    const first = await fetch(`${ORIGIN}/api/beacon`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ ctx: "forum:2" }),
    });

    expect(first.status).toBe(204);

    const cookie = first.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^bl_guest=[0-9a-f-]{36};/);

    const guest = cookie.split(";")[0] ?? "";
    const second = await fetch(`${ORIGIN}/api/beacon`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie: guest },
      body: JSON.stringify({ ctx: "topic:201" }),
    });

    expect(second.status).toBe(204);
    expect(second.headers.get("set-cookie")).toBeNull();
  });

  test("the beacon rejects a bad context, a missing origin and is rate limited", async () => {
    await resetRateBuckets();

    const invalid = await fetch(`${ORIGIN}/api/beacon`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ ctx: "not-a-context" }),
    });

    expect(invalid.status).toBe(400);

    const noOrigin = await fetch(`${ORIGIN}/api/beacon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ctx: "forum:2" }),
    });

    expect(noOrigin.status).toBe(403);

    const statuses: number[] = [];

    for (let index = 0; index < 61; index += 1) {
      const response = await fetch(`${ORIGIN}/api/beacon`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ ctx: "forum:2" }),
      });

      statuses.push(response.status);
    }

    expect(statuses).toContain(429);

    await resetRateBuckets();
  }, 30_000);

  test("the benchmark session endpoint issues a working member session", async () => {
    const response = await fetch(`${ORIGIN}/api/test/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ sub: "member-1" }),
    });

    expect(response.status).toBe(200);

    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toMatch(/^(?:__Host-)?bl_session=/);

    const member = await fetch(`${ORIGIN}/_demo/2`, { headers: { cookie } });
    expect(member.headers.get("cache-control")).toBe("private, no-store");
    expect(await member.text()).toContain('data-visitor="member"');

    const noOrigin = await fetch(`${ORIGIN}/api/test/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sub: "member-1" }),
    });
    expect(noOrigin.status).toBe(403);
  });

  test("the overlay requires its header, a session and the right origin", async () => {
    const missingHeader = await fetch(`${ORIGIN}/api/me/overlay`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ ctx: "forum:2" }),
    });

    expect(missingHeader.status).toBe(403);
    expect(await missingHeader.json()).toEqual({ code: "overlay_required" });

    const noSession = await fetch(`${ORIGIN}/api/me/overlay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-bulletin-overlay": "1",
      },
      body: JSON.stringify({ ctx: "forum:2" }),
    });

    expect(noSession.status).toBe(401);

    const wrongOrigin = await fetch(`${ORIGIN}/api/me/overlay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://evil.test",
        "x-bulletin-overlay": "1",
      },
      body: JSON.stringify({ ctx: "forum:2" }),
    });

    expect(wrongOrigin.status).toBe(403);

    const wrongMethod = await fetch(`${ORIGIN}/api/me/overlay`, {
      headers: { origin: ORIGIN, "x-bulletin-overlay": "1" },
    });

    expect(wrongMethod.status).toBe(405);
  });
});
