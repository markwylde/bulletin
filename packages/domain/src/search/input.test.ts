import { describe, expect, test } from "bun:test";
import {
  isSearchId,
  isSimpleSearchQuery,
  normalizeSearchQuery,
  parseSearchDate,
  parseSearchId,
  parseSearchIds,
  parseSearchKind,
  parseSearchPage,
  parseSearchPageSize,
  parseSearchSort,
} from "./input.ts";

describe("search input parsing", () => {
  test("normalises free-form query text", () => {
    expect(normalizeSearchQuery("  running\u0000fast  ")).toBe("running fast");
    expect(normalizeSearchQuery("x".repeat(500))).toHaveLength(200);
    expect(normalizeSearchQuery(null)).toBe("");
  });

  test("falls back to safe defaults for unknown options", () => {
    expect(parseSearchKind("topics")).toBe("topics");
    expect(parseSearchKind("nope")).toBe("posts");
    expect(parseSearchSort("date")).toBe("date");
    expect(parseSearchSort("nope")).toBe("relevance");
    expect(parseSearchPage("-2")).toBe(1);
    expect(parseSearchPage("3")).toBe(3);
    expect(parseSearchPageSize("500")).toBe(100);
    expect(parseSearchPageSize("nope")).toBe(20);
  });

  test("parses dates and bigint IDs", () => {
    expect(parseSearchDate("2026-02-03")?.toISOString()).toBe("2026-02-03T00:00:00.000Z");
    expect(parseSearchDate("03/02/2026")).toBeNull();
    expect(parseSearchId("12")).toBe("12");
    expect(parseSearchId("0")).toBeNull();
    expect(parseSearchIds(["1", "1", "2", "x", null])).toEqual(["1", "2"]);
  });

  test("rejects IDs above PostgreSQL's bigint maximum", () => {
    expect(isSearchId("9223372036854775807")).toBe(true);
    expect(parseSearchId("9223372036854775807")).toBe("9223372036854775807");
    expect(isSearchId("9223372036854775808")).toBe(false);
    expect(isSearchId("9999999999999999999")).toBe(false);
    expect(parseSearchId("9223372036854775808")).toBeNull();
    expect(parseSearchIds(["12", "9223372036854775808"])).toEqual(["12"]);
  });

  test("only treats plain words as simple queries", () => {
    expect(isSimpleSearchQuery("maintanance")).toBe(true);
    expect(isSimpleSearchQuery("power-supply")).toBe(true);
    expect(isSimpleSearchQuery('"power supply"')).toBe(false);
    expect(isSimpleSearchQuery("power -laptop")).toBe(false);
    expect(isSimpleSearchQuery("power OR laptop")).toBe(false);
    expect(isSimpleSearchQuery("power or laptop")).toBe(false);
  });
});
