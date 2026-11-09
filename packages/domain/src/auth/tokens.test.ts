import { describe, expect, test } from "bun:test";
import {
  challengeCookieName,
  createCsrfToken,
  hashToken,
  parseCookieHeader,
  safeReturnTo,
  serializeCookie,
  sessionCookieName,
} from "./tokens.ts";

describe("auth tokens and cookies", () => {
  test("hashes tokens with SHA-256 and derives stable CSRF tokens", () => {
    expect(Buffer.from(hashToken("token")).toString("hex")).toBe(
      "3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0",
    );

    expect(createCsrfToken("42", "secret")).toBe(createCsrfToken("42", "secret"));
    expect(createCsrfToken("42", "secret")).not.toBe(createCsrfToken("43", "secret"));
  });

  test("uses host-only prefixed cookies in production", () => {
    expect(sessionCookieName("user", "production")).toBe("__Host-bl_session");
    expect(sessionCookieName("staff", "production")).toBe("__Host-bl_staff");
    expect(sessionCookieName("user", "test")).toBe("bl_session");
    expect(sessionCookieName("staff", "test")).toBe("bl_staff");
    expect(challengeCookieName("production")).toBe("__Host-bl_login");
    expect(challengeCookieName("development")).toBe("bl_login");
  });

  test("serialises http-only same-site cookies", () => {
    expect(serializeCookie("bl_session", "abc", { maxAge: 60, secure: true })).toBe(
      "bl_session=abc; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax",
    );
    expect(serializeCookie("bl_login", "", { maxAge: 0 })).toBe(
      "bl_login=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    );
  });

  test("parses the cookie header without throwing on malformed pairs", () => {
    expect(parseCookieHeader("bl_session=one; bl_login=2; broken; =empty")).toEqual({
      bl_session: "one",
      bl_login: "2",
    });
    expect(parseCookieHeader(null)).toEqual({});
  });

  test("accepts only same-origin relative return paths", () => {
    expect(safeReturnTo("/topic/12-welcome?page=2")).toBe("/topic/12-welcome?page=2");
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("https://evil.test/")).toBeNull();
    expect(safeReturnTo("//evil.test/")).toBeNull();
    expect(safeReturnTo("/\\evil.test")).toBeNull();
    expect(safeReturnTo("javascript:alert(1)")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });
});
