import { describe, expect, test } from "bun:test";
import { VIEWPORTS } from "./e2e.ts";

describe("E2E viewport presets", () => {
  test("covers the minimum mobile, common mobile, tablet and desktop sizes", () => {
    expect(VIEWPORTS.mobile360).toEqual({ width: 360, height: 780 });
    expect(VIEWPORTS.mobile390).toEqual({ width: 390, height: 844 });
    expect(VIEWPORTS.tablet).toEqual({ width: 768, height: 1024 });
    expect(VIEWPORTS.desktop).toEqual({ width: 1440, height: 900 });
  });
});
