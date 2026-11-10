import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { USER_CATALOGS } from "../catalogs.ts";
import {
  boardNameFrom,
  languageSwitcherView,
  localeSuggestionView,
  pageRegions,
} from "./render.ts";

const t = createServerT("en", { shipped: USER_CATALOGS });

describe("theme regions", () => {
  test("builds header, breadcrumbs, empty and footer regions", () => {
    const regions = pageRegions({
      boardName: "Bulletin",
      locale: "en",
      translate: t,
      breadcrumbs: [{ label: "Home", href: null }],
      year: 2026,
    });

    expect(regions.map((region) => region.name)).toEqual([
      "header",
      "breadcrumbs",
      "empty",
      "footer",
    ]);
    expect(regions[2]?.key).toBe("emptyState");
    expect(regions[0]?.viewModel).toMatchObject({
      boardName: "Bulletin",
      localeSuggestion: expect.objectContaining({ current: "en" }),
    });
    expect(regions[0]?.viewModel).not.toHaveProperty("isMember");
    expect(regions[1]?.viewModel).toEqual({ items: [{ label: "Home", href: null }] });
    expect(regions[3]?.viewModel).toEqual({ boardName: "Bulletin", year: 2026 });
  });

  test("never varies the shared header by membership", () => {
    const guest = pageRegions({
      boardName: "Bulletin",
      locale: "fr",
      translate: t,
      breadcrumbs: [],
    });
    const member = pageRegions({
      boardName: "Bulletin",
      locale: "fr",
      translate: t,
      breadcrumbs: [],
    });

    // The same fragment serves both; the per-request shell reveals member-only UI.
    expect(guest).toEqual(member);
    expect(guest[0]?.viewModel).not.toHaveProperty("isMember");
    expect(guest[0]?.viewModel).toMatchObject({
      localeSuggestion: expect.objectContaining({ current: "fr" }),
    });
  });
});

describe("language props", () => {
  test("lists the shipped languages in their own names", () => {
    const view = languageSwitcherView("fr", t);

    expect(view.current).toBe("fr");
    expect(view.options).toEqual([
      { value: "en", label: "English" },
      { value: "es", label: "Español" },
      { value: "fr", label: "Français" },
    ]);
    expect(view.label).toBe("Language");
  });

  test("provides the banner copy", () => {
    const view = localeSuggestionView("en", t);

    expect(view.message.length).toBeGreaterThan(0);
    expect(view.accept).toBe("Switch");
    expect(view.dismiss).toBe("Dismiss");
  });
});

describe("boardNameFrom", () => {
  test("falls back to the shipped name", () => {
    expect(boardNameFrom("Bulletin", t)).toBe("Bulletin");
    expect(boardNameFrom("   ", t)).toBe("Bulletin");
    expect(boardNameFrom(undefined, t)).toBe("Bulletin");
  });
});
