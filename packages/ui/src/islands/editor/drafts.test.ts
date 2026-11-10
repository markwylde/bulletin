import { describe, expect, test } from "bun:test";
import { draftWriteFor } from "./drafts.ts";

describe("draft write mode", () => {
  test("clears the draft when an edit is undone back to the original", () => {
    expect(draftWriteFor("original", "changed", true)).toBe("save");
    expect(draftWriteFor("original", "original", true)).toBe("clear");
  });

  test("does nothing before the member edits", () => {
    expect(draftWriteFor("original", "original", false)).toBe("none");
  });
});
