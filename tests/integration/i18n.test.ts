import { describe, expect, test } from "bun:test";
import { t } from "@bulletin/i18n";

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const BASE = Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080";

integrationDescribe("user app placeholder locale data", () => {
  test("ships every locale catalog and renders English by default", async () => {
    const response = await fetch(`${BASE}/`);
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain(t("en", "user.placeholder.body"));
    expect(html).toContain('id="i18n-catalog"');
    expect(html).toContain('"es"');
    expect(html).toContain('"fr"');
  });
});
