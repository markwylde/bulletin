import { describe, expect, test } from "bun:test";
import {
  authIssuer,
  DEFAULT_HTTP_PORT,
  httpPort,
  stackOrigin,
  staffBaseUrl,
  staffOrigin,
  userBaseUrl,
  userOrigin,
} from "./urls.ts";

describe("stack URLs", () => {
  test("defaults to port 8080", () => {
    expect(DEFAULT_HTTP_PORT).toBe(8080);
    expect(httpPort({})).toBe(8080);
    expect(userOrigin({})).toBe("http://bulletin.localhost:8080");
    expect(staffOrigin({})).toBe("http://staff.bulletin.localhost:8080");
    expect(authIssuer({})).toBe("http://auth.bulletin.localhost:8080");
  });

  test("derives every public origin from BULLETIN_HTTP_PORT", () => {
    const env = { BULLETIN_HTTP_PORT: "18080" };

    expect(httpPort(env)).toBe(18080);
    expect(stackOrigin("user", env)).toBe("http://bulletin.localhost:18080");
    expect(stackOrigin("files", env)).toBe("http://files.bulletin.localhost:18080");
    expect(stackOrigin("plugins", env)).toBe("http://plugins.bulletin.localhost:18080");
    expect(authIssuer(env)).toBe("http://auth.bulletin.localhost:18080");
  });

  test("lets explicit base URL variables win", () => {
    const env = {
      BULLETIN_HTTP_PORT: "18080",
      BULLETIN_BASE_URL: "https://forum.example.test",
      BULLETIN_STAFF_BASE_URL: "https://staff.example.test",
    };

    expect(userBaseUrl(env)).toBe("https://forum.example.test");
    expect(staffBaseUrl(env)).toBe("https://staff.example.test");
  });

  test("rejects a malformed or out-of-range port", () => {
    expect(() => httpPort({ BULLETIN_HTTP_PORT: "eight" })).toThrow("must be an integer");
    expect(() => httpPort({ BULLETIN_HTTP_PORT: "0" })).toThrow("between 1 and 65535");
    expect(() => httpPort({ BULLETIN_HTTP_PORT: "70000" })).toThrow("between 1 and 65535");
  });

  test("treats a blank port as unset", () => {
    expect(httpPort({ BULLETIN_HTTP_PORT: "  " })).toBe(8080);
  });
});
