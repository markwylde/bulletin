import { describe, expect, test } from "bun:test";
import {
  canonicalUrl,
  parseResourcePath,
  type ResourceRef,
  resolveResourceUrl,
  slugify,
  slugStatus,
} from "./index.ts";

function parsed(path: string): ResourceRef {
  const ref = parseResourcePath(path);

  if (ref === null) {
    throw new Error(`Expected ${path} to parse`);
  }

  return ref;
}

describe("resource URLs", () => {
  test("parses forum, topic and profile URLs by ID", () => {
    expect(parseResourcePath("/forum/12-general-discussion")).toEqual({
      kind: "forum",
      id: 12n,
      slug: "general-discussion",
      page: null,
      postId: null,
    });
    expect(parseResourcePath("/topic/345-welcome/page/2")).toEqual({
      kind: "topic",
      id: 345n,
      slug: "welcome",
      page: 2,
      postId: null,
    });
    expect(parseResourcePath("/topic/345-welcome/post/9876")).toEqual({
      kind: "topic",
      id: 345n,
      slug: "welcome",
      page: null,
      postId: 9876n,
    });
  });

  test("rejects unknown routes, non-numeric IDs and page/post on non-topics", () => {
    expect(parseResourcePath("/category/1")).toBeNull();
    expect(parseResourcePath("/forum/abc")).toBeNull();
    expect(parseResourcePath("/forum/0")).toBeNull();
    expect(parseResourcePath("/forum/12-name/page/2")).toBeNull();
    expect(parseResourcePath("/profile/7-jane/post/1")).toBeNull();
    expect(parseResourcePath("/topic/1-name/page/0")).toBeNull();
  });

  test("reports missing, outdated and correct slugs", () => {
    const missing = parsed("/forum/12");
    const outdated = parsed("/forum/12-old-name");
    const correct = parsed("/forum/12-general-discussion");

    expect(slugStatus(missing, "General Discussion")).toBe("missing");
    expect(slugStatus(outdated, "General Discussion")).toBe("outdated");
    expect(slugStatus(correct, "General Discussion")).toBe("ok");
  });

  test("301s missing and outdated slugs to the canonical URL", () => {
    const missing = parsed("/topic/345/page/2");
    const outdated = parsed("/topic/345-old/page/2");

    expect(resolveResourceUrl(missing, "Welcome")).toEqual({
      status: 301,
      location: "/topic/345-welcome/page/2",
    });
    expect(resolveResourceUrl(outdated, "Welcome")).toEqual({
      status: 301,
      location: "/topic/345-welcome/page/2",
    });
  });

  test("returns 200 for a correct slug and preserves post anchors", () => {
    const correct = parsed("/topic/345-welcome/post/9876");
    expect(resolveResourceUrl(correct, "Welcome")).toEqual({ status: 200, location: null });

    const outdated = parsed("/topic/345-old/post/9876");
    expect(resolveResourceUrl(outdated, "Welcome").location).toBe("/topic/345-welcome/post/9876");
  });

  test("builds canonical URLs with safe slugs", () => {
    expect(canonicalUrl("forum", 12n, "General Discussion")).toBe("/forum/12-general-discussion");
    expect(canonicalUrl("profile", 77, "José Álvarez")).toBe("/profile/77-jose-alvarez");
    expect(canonicalUrl("topic", "345", "Welcome!", { page: 2 })).toBe("/topic/345-welcome/page/2");
    expect(canonicalUrl("topic", 345n, "Welcome", { postId: 9876n })).toBe(
      "/topic/345-welcome/post/9876",
    );
  });

  test("slugifies accents and punctuation", () => {
    expect(slugify("  Héllo, Wörld!  ")).toBe("hello-world");
    expect(slugify("***")).toBe("item");
  });

  test("rejects invalid IDs when building a URL", () => {
    expect(() => canonicalUrl("forum", 0n, "x")).toThrow(RangeError);
  });
});
