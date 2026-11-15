import { describe, expect, test } from "bun:test";
import { initials } from "./AccountMenu.tsx";
import { matchSections } from "./CommandPalette.tsx";
import { userSiteUrl } from "./Shell.tsx";

const entries = [
  { label: "Board settings", haystack: "board settings system configuration" },
  { label: "Groups", haystack: "groups members groups & access" },
  { label: "Group settings", haystack: "group settings members groups & access" },
  { label: "Permissions", haystack: "permissions members groups & access" },
  { label: "Réglages", haystack: "reglages systeme" },
];

describe("section search", () => {
  test("returns every section for an empty query", () => {
    expect(matchSections(entries, "  ").map((entry) => entry.label)).toHaveLength(entries.length);
  });

  test("ranks label prefixes before word and area matches", () => {
    expect(matchSections(entries, "group").map((entry) => entry.label)).toEqual([
      "Groups",
      "Group settings",
      "Permissions",
    ]);
    expect(matchSections(entries, "settings").map((entry) => entry.label)).toEqual([
      "Board settings",
      "Group settings",
    ]);
  });

  test("ignores case and accents", () => {
    expect(matchSections(entries, "REGLA").map((entry) => entry.label)).toEqual(["Réglages"]);
  });

  test("returns nothing when no section matches", () => {
    expect(matchSections(entries, "zzz")).toEqual([]);
  });
});

describe("shell helpers", () => {
  test("links to the user origin from the staff origin", () => {
    expect(userSiteUrl("http://staff.bulletin.localhost:8080")).toBe(
      "http://bulletin.localhost:8080/",
    );
    expect(userSiteUrl("https://staff.forum.example")).toBe("https://forum.example/");
    expect(userSiteUrl("https://admin.example")).toBe("https://admin.example/");
  });

  test("derives avatar initials from the display name", () => {
    expect(initials("Super Moderator")).toBe("SM");
    expect(initials("admin")).toBe("A");
    expect(initials("  ")).toBe("?");
    expect(initials(null)).toBe("?");
  });
});
