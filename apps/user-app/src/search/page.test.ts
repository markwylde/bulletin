import { describe, expect, test } from "bun:test";
import { parseSearchMemberRef } from "./page.ts";

describe("search member refs", () => {
  test("accepts in-range IDs with an optional slug", () => {
    expect(parseSearchMemberRef("12-regular-member")).toEqual({
      id: "12",
      slug: "regular-member",
    });
    expect(parseSearchMemberRef("12")).toEqual({ id: "12", slug: null });
    expect(parseSearchMemberRef("9223372036854775807-maximum")).toEqual({
      id: "9223372036854775807",
      slug: "maximum",
    });
  });

  test("rejects malformed and out-of-range IDs", () => {
    expect(parseSearchMemberRef("0")).toBeNull();
    expect(parseSearchMemberRef("nope")).toBeNull();
    expect(parseSearchMemberRef("9223372036854775808")).toBeNull();
    expect(parseSearchMemberRef("9223372036854775808-missing")).toBeNull();
  });
});
