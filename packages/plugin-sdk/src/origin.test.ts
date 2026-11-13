import { describe, expect, test } from "bun:test";
import { conventionalPluginOrigin, isLoopbackHostname, parsePluginOrigin } from "./origin.ts";

describe("plugin origin policy", () => {
  test("accepts an exact https origin on a different registrable domain", () => {
    expect(parsePluginOrigin("https://plugins.forum-usercontent.com")).toBe(
      "https://plugins.forum-usercontent.com",
    );
    expect(parsePluginOrigin("https://plugins.forum-usercontent.com/")).toBe(
      "https://plugins.forum-usercontent.com",
    );
  });

  test("accepts http only for loopback development hosts", () => {
    expect(parsePluginOrigin("http://plugins.bulletin.localhost:18080")).toBe(
      "http://plugins.bulletin.localhost:18080",
    );
    expect(parsePluginOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parsePluginOrigin("http://plugins.forum-usercontent.com")).toBeUndefined();
    expect(isLoopbackHostname("plugins.bulletin.localhost")).toBe(true);
    expect(isLoopbackHostname("forum-usercontent.com")).toBe(false);
  });

  test("rejects paths, queries, fragments and credentials", () => {
    expect(parsePluginOrigin("https://plugins.example.com/app/client.html")).toBeUndefined();
    expect(parsePluginOrigin("https://plugins.example.com/?x=1")).toBeUndefined();
    expect(parsePluginOrigin("https://plugins.example.com/#top")).toBeUndefined();
    expect(parsePluginOrigin("https://user:pass@plugins.example.com")).toBeUndefined();
    expect(parsePluginOrigin("ftp://plugins.example.com")).toBeUndefined();
    expect(parsePluginOrigin("not a url")).toBeUndefined();
    expect(parsePluginOrigin("")).toBeUndefined();
  });

  test("only falls back to the conventional plugin host without a configured origin", () => {
    expect(conventionalPluginOrigin("http://bulletin.localhost:8080/forum/1")).toBe(
      "http://plugins.bulletin.localhost:8080",
    );
    expect(conventionalPluginOrigin("https://forum.example.com/topic/1")).toBe(
      "https://plugins.forum.example.com",
    );
    expect(conventionalPluginOrigin("https://plugins.forum.example.com/app")).toBe(
      "https://plugins.forum.example.com",
    );
  });
});
