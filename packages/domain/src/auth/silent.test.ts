import { describe, expect, test } from "bun:test";
import { reauthRedirectUrl, shouldRedirectToReauth } from "./silent.ts";

describe("silent re-auth navigation check", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const past = new Date(now.getTime() - 60_000).toISOString();
  const future = new Date(now.getTime() + 60_000).toISOString();

  test("redirects an expired user session on a top-level navigation", () => {
    expect(
      shouldRedirectToReauth({
        method: "GET",
        secFetchMode: "navigate",
        pathname: "/topic/12-welcome",
        reauthAt: past,
        now,
      }),
    ).toBe(true);
  });

  test("does not redirect fresh sessions, background requests or non-page paths", () => {
    const base = {
      method: "GET",
      secFetchMode: "navigate",
      pathname: "/topic/12-welcome",
      reauthAt: past,
      now,
    };

    expect(shouldRedirectToReauth({ ...base, reauthAt: future })).toBe(false);
    expect(shouldRedirectToReauth({ ...base, reauthAt: null })).toBe(false);
    expect(shouldRedirectToReauth({ ...base, secFetchMode: "cors" })).toBe(false);
    expect(shouldRedirectToReauth({ ...base, method: "POST" })).toBe(false);

    for (const pathname of ["/api/auth/session", "/health/ready", "/auth/callback", "/_mocks"]) {
      expect(shouldRedirectToReauth({ ...base, pathname })).toBe(false);
    }
  });

  test("builds a relative refresh URL", () => {
    expect(reauthRedirectUrl("/topic/12-welcome?page=2")).toBe(
      "/api/auth/refresh?return_to=%2Ftopic%2F12-welcome%3Fpage%3D2",
    );
    expect(reauthRedirectUrl("//evil.test")).toBe("/api/auth/refresh?return_to=%2F");
  });
});
