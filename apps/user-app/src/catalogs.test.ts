import { describe, expect, test } from "bun:test";
import { createServerT } from "@bulletin/i18n";
import { USER_CATALOGS } from "./catalogs.ts";

describe("merged app catalogs", () => {
  test("includes keys supplied by shared packages", () => {
    const t = createServerT("es", { shipped: USER_CATALOGS });

    expect(t("common.siteName")).toBe("Bulletin");
    expect(t("user.placeholder.body")).toBe(USER_CATALOGS.es["user.placeholder.body"]);
  });
});
