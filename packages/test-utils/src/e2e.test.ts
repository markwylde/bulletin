import { describe, expect, test } from "bun:test";
import { isBrowserNoise, VIEWPORTS } from "./e2e.ts";

describe("E2E viewport presets", () => {
  test("covers the minimum mobile, common mobile, tablet and desktop sizes", () => {
    expect(VIEWPORTS.mobile360).toEqual({ width: 360, height: 780 });
    expect(VIEWPORTS.mobile390).toEqual({ width: 390, height: 844 });
    expect(VIEWPORTS.tablet).toEqual({ width: 768, height: 1024 });
    expect(VIEWPORTS.desktop).toEqual({ width: 1440, height: 900 });
  });
});

describe("browser noise", () => {
  test("ignores the late install-icon CSP refusal, but not other refused images", () => {
    expect(
      isBrowserNoise(
        `Refused to load the image 'http://bulletin.localhost:34247/pwa/icon-192.png?theme=1%401' because it violates the following Content Security Policy directive: "img-src 'self' data:".`,
      ),
    ).toBe(true);
    expect(
      isBrowserNoise(
        `Refused to load the image 'http://bulletin.localhost:34247/avatars/1.png' because it violates the following Content Security Policy directive: "img-src 'self' data:".`,
      ),
    ).toBe(false);
  });
});
