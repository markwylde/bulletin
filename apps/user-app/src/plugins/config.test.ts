import { describe, expect, test } from "bun:test";
import { configuredPluginOrigin } from "./config.ts";

describe("configured plugin origin", () => {
  test("uses the configured separate-domain https origin", () => {
    expect(
      configuredPluginOrigin({
        BULLETIN_PLUGINS_ORIGIN: "https://plugins.forum-usercontent.com",
        BULLETIN_HTTP_PORT: "18080",
      }),
    ).toBe("https://plugins.forum-usercontent.com");
  });

  test("falls back to the compose plugin host, keeping the configured port", () => {
    expect(configuredPluginOrigin({ BULLETIN_HTTP_PORT: "18080" })).toBe(
      "http://plugins.bulletin.localhost:18080",
    );
    expect(configuredPluginOrigin({})).toBe("http://plugins.bulletin.localhost:8080");
  });

  test("ignores an insecure or malformed override", () => {
    expect(
      configuredPluginOrigin({
        BULLETIN_PLUGINS_ORIGIN: "http://plugins.forum-usercontent.com",
        BULLETIN_HTTP_PORT: "18080",
      }),
    ).toBe("http://plugins.bulletin.localhost:18080");
    expect(
      configuredPluginOrigin({ BULLETIN_PLUGINS_ORIGIN: "https://plugins.example.com/app" }),
    ).toBe("http://plugins.bulletin.localhost:8080");
  });
});
