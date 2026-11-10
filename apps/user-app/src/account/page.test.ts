import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { USER_CATALOGS } from "../catalogs.ts";
import { accountLabels } from "./page.ts";

describe("account labels", () => {
  test("maps browser families for the sessions list", () => {
    const labels = accountLabels(createServerT("en", { shipped: USER_CATALOGS }));

    expect(labels.browsers.chrome).toBe("Chrome");
    expect(labels.browsers.samsung).toBe("Samsung Internet");
    expect(labels.unknownBrowser).toBe("Unknown browser");
    expect(labels.current).toBe("This device");
  });

  test("carries the display-name errors", () => {
    const labels = accountLabels(createServerT("fr", { shipped: USER_CATALOGS }));

    expect(labels.taken.length).toBeGreaterThan(0);
    expect(labels.limit.length).toBeGreaterThan(0);
    expect(labels.saveFailed.length).toBeGreaterThan(0);
  });
});
