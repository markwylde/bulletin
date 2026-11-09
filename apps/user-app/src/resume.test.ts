import { describe, expect, test } from "bun:test";
import type { AuthFetch, StashedRequest } from "@bulletin/domain/auth/browser";
import { resumeStashedRequest } from "./resume.ts";

const stashed: StashedRequest = {
  url: "/api/drafts/3",
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { kind: "text", value: '{"body":"unsent"}', contentType: "application/json" },
  ownerMemberId: "member-1",
};

describe("stashed request resume", () => {
  test("retains the request after a failed response", async () => {
    let cleared = false;
    const fetch: AuthFetch = async () => new Response(null, { status: 500 });

    const result = await resumeStashedRequest({
      take: () => stashed,
      clear: () => {
        cleared = true;
      },
      fetch,
    });

    expect(result).toBe("retained");
    expect(cleared).toBe(false);
  });

  test("retains the request after a network error", async () => {
    let cleared = false;
    const fetch: AuthFetch = async () => {
      throw new Error("network down");
    };

    const result = await resumeStashedRequest({
      take: () => stashed,
      clear: () => {
        cleared = true;
      },
      fetch,
    });

    expect(result).toBe("retained");
    expect(cleared).toBe(false);
  });

  test("clears only after a successful response", async () => {
    let cleared = false;
    let body: RequestInit["body"] | undefined;
    const fetch: AuthFetch = async (_input, init) => {
      body = init?.body;
      return new Response(null, { status: 204 });
    };

    const result = await resumeStashedRequest({
      take: () => stashed,
      clear: () => {
        cleared = true;
      },
      fetch,
    });

    expect(result).toBe("success");
    expect(cleared).toBe(true);
    expect(body).toBe('{"body":"unsent"}');
  });

  test("does nothing when no request was stashed", async () => {
    let cleared = false;
    let called = false;
    const fetch: AuthFetch = async () => {
      called = true;
      return new Response(null, { status: 200 });
    };

    const result = await resumeStashedRequest({
      take: () => null,
      clear: () => {
        cleared = true;
      },
      fetch,
    });

    expect(result).toBe("none");
    expect(cleared).toBe(false);
    expect(called).toBe(false);
  });
});
