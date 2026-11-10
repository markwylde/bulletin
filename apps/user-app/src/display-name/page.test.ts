import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { USER_CATALOGS } from "../catalogs.ts";
import { buildDisplayNamePage, displayNameLabels } from "./page.ts";

const t = createServerT("en", { shipped: USER_CATALOGS });

describe("display-name step page", () => {
  test("builds the view model for a member without a name", () => {
    const page = buildDisplayNamePage({ returnTo: "/topic/1", currentName: null, translate: t });

    expect(page.title).toBe("Choose a display name");
    expect(page.breadcrumbs).toEqual([{ label: "Choose a display name", href: null }]);
    expect(page.viewModel).toEqual({ currentName: "", returnTo: "/topic/1" });
  });

  test("provides the error messages the form script needs", () => {
    const labels = displayNameLabels(t);

    expect(labels.required).toBe("Choose a display name before continuing.");
    expect(labels.taken).toBe("That name is already taken.");
    expect(labels.invalid).toBe("Display names must be 3–32 characters.");
    expect(labels.limit.length).toBeGreaterThan(0);
    expect(labels.saveFailed.length).toBeGreaterThan(0);
  });

  test("translates the step page", () => {
    const es = createServerT("es", { shipped: USER_CATALOGS });
    const page = buildDisplayNamePage({ returnTo: "/", currentName: null, translate: es });

    expect(page.title).toBe("Elige un nombre visible");
  });
});
