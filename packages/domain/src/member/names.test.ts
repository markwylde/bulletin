import { describe, expect, test } from "bun:test";
import { displayNameSkeleton, NAME_CHANGE_INTERVAL_MS, validateDisplayName } from "./names.ts";

describe("display name skeleton and validation", () => {
  test("folds case, diacritics and confusable scripts", () => {
    expect(displayNameSkeleton("Admin")).toBe("admin");
    expect(displayNameSkeleton("Admіn")).toBe("admin");
    expect(displayNameSkeleton("Αdmin")).toBe("admin");
    expect(displayNameSkeleton("Ａdmin")).toBe("admin");
    expect(displayNameSkeleton("José")).toBe("jose");
    expect(displayNameSkeleton("  Miembro   Español  ")).toBe("miembro espanol");
  });

  test("accepts 3–32 code points and rejects invalid or control-filled names", () => {
    expect(validateDisplayName("  Ada  ")).toEqual({
      ok: true,
      name: "Ada",
      skeleton: "ada",
    });
    expect(validateDisplayName("ab").ok).toBe(false);
    expect(validateDisplayName("a".repeat(33)).ok).toBe(false);
    expect(validateDisplayName("Ada\u0000Lovelace").ok).toBe(false);
    expect(validateDisplayName("Ada\u200bLovelace").ok).toBe(false);
    expect(validateDisplayName(42).ok).toBe(false);
  });

  test("uses a 30-day change interval", () => {
    expect(NAME_CHANGE_INTERVAL_MS).toBe(30 * 24 * 60 * 60 * 1_000);
  });
});
