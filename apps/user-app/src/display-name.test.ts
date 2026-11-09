import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { USER_CATALOGS } from "./catalogs.ts";
import { displayNameCopy, displayNameError } from "./display-name.ts";

const t = createServerT("en", { shipped: USER_CATALOGS });

describe("display-name copy", () => {
  test("provides the step page labels", () => {
    expect(displayNameCopy(t)).toEqual({
      title: "Choose a display name",
      label: "Display name",
      help: "3–32 characters. Names are unique and visible to everyone.",
      save: "Save display name",
    });
  });

  test("maps API error codes to messages", () => {
    expect(displayNameError(t, "display_name_required")).toBe(
      "Choose a display name before continuing.",
    );
    expect(displayNameError(t, "display_name_taken")).toBe("That name is already taken.");
    expect(displayNameError(t, "display_name_invalid")).toBe(
      "Display names must be 3–32 characters.",
    );
    expect(
      displayNameError(t, "display_name_change_limit", { nextAllowedAt: "2026-12-01" }),
    ).toContain("2026-12-01");
    expect(displayNameError(t, "something_else")).toBe("Sign-in failed. Please try again.");
  });
});
