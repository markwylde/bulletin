import { describe, expect, test } from "bun:test";
import { parseNotificationsPageParam } from "./notifications.ts";

describe("notifications page parameter", () => {
  test("reads a one-based page number", () => {
    expect(parseNotificationsPageParam("1")).toBe(1);
    expect(parseNotificationsPageParam("2")).toBe(2);
    expect(parseNotificationsPageParam("0003")).toBe(3);
  });

  test("clamps zero to the first page", () => {
    expect(parseNotificationsPageParam("0")).toBe(1);
  });

  test("ignores a missing or malformed value so the first page still renders", () => {
    expect(parseNotificationsPageParam(null)).toBeUndefined();
    expect(parseNotificationsPageParam("")).toBeUndefined();
    expect(parseNotificationsPageParam("two")).toBeUndefined();
    expect(parseNotificationsPageParam("-1")).toBeUndefined();
    expect(parseNotificationsPageParam("1.5")).toBeUndefined();
    expect(parseNotificationsPageParam("1234567")).toBeUndefined();
  });
});
