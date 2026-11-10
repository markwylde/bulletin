import { describe, expect, test } from "bun:test";
import {
  forumTag,
  GLOBAL_CACHE_TAGS,
  i18nTag,
  memberTag,
  postSnapshotsTag,
  themeTag,
  topicPagesTag,
  topicTag,
  topicViewsTag,
} from "./tags.ts";

describe("cache tags", () => {
  test("builds the ADR 0006 resource tags", () => {
    expect(forumTag("12")).toBe("forum:12");
    expect(topicTag("345")).toBe("topic:345");
    expect(topicPagesTag("345")).toBe("topic:345:pages");
    expect(topicViewsTag("345")).toBe("topic:345:views");
    expect(postSnapshotsTag("9876")).toBe("post:9876:snapshots");
    expect(memberTag("7")).toBe("member:7");
    expect(themeTag(3)).toBe("theme:3");
    expect(i18nTag("fr")).toBe("i18n:fr");
  });

  test("exposes the global tags", () => {
    expect(GLOBAL_CACHE_TAGS).toEqual({
      perm: "perm",
      flags: "flags",
      plugins: "plugins",
      announcements: "announcements",
      board: "board",
    });
  });

  test("rejects a non-numeric resource id", () => {
    expect(() => forumTag("general")).toThrow("numeric id");
    expect(() => topicTag("")).toThrow("numeric id");
    expect(() => postSnapshotsTag("12ab")).toThrow("numeric id");
  });
});
