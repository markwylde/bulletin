import { describe, expect, test } from "bun:test";
import { diffLines } from "./diff.ts";

describe("theme template diff", () => {
  test("marks a changed line as a removal and an addition", () => {
    expect(diffLines("a\nb\nc", "a\nbee\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "bee" },
      { kind: "same", text: "c" },
    ]);
  });

  test("keeps unchanged templates empty of changes", () => {
    expect(diffLines("<p>Hello</p>", "<p>Hello</p>")).toEqual([
      { kind: "same", text: "<p>Hello</p>" },
    ]);
  });

  test("reports additions and removals at the ends", () => {
    expect(diffLines("", "one")).toEqual([{ kind: "add", text: "one" }]);
    expect(diffLines("one", "")).toEqual([{ kind: "remove", text: "one" }]);
  });
});
