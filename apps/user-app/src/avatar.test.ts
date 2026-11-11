import { describe, expect, test } from "bun:test";
import { avatarHue, avatarStyle, initials, initialsSvg } from "./avatar.ts";

describe("initials avatar", () => {
  test("uses the first two initials and a fallback", () => {
    expect(initials("Jane Doe")).toBe("JD");
    expect(initials("  jane   doe  ")).toBe("JD");
    expect(initials("Cher")).toBe("C");
    expect(initials("")).toBe("?");
  });

  test("derives a stable colour from the member id", () => {
    expect(avatarHue("42")).toBe(avatarHue("42"));
    expect(avatarHue("42")).toBeGreaterThanOrEqual(0);
    expect(avatarHue("42")).toBeLessThan(360);
    expect(avatarHue("42")).not.toBe(avatarHue("43"));
    expect(avatarStyle("42")).toContain("--bl-avatar-hue:");
  });

  test("renders the fallback as inline SVG with the stable colour", () => {
    const first = initialsSvg("42", "Jane Doe");
    const second = initialsSvg("42", "Jane Doe");
    const other = initialsSvg("43", "Jane Doe");

    expect(first).toBe(second);
    expect(first).toContain("data-member-initials");
    expect(first).toContain("--bl-avatar-hue:");
    expect(first).toContain(">JD</text>");
    expect(first).not.toContain("<img");
    expect(first).not.toBe(other);
  });
});
