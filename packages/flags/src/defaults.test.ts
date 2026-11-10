import { describe, expect, test } from "bun:test";
import { announcementsFlag, CODE_FLAG_DEFINITIONS } from "./defaults.ts";

describe("announcements flag declaration", () => {
  test("is declared off by default and part of the cache variant", () => {
    expect(CODE_FLAG_DEFINITIONS).toContain(announcementsFlag);
    expect(announcementsFlag).toMatchObject({
      key: "announcements",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
  });
});
