import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { baseSeedModule, runSeeds, SeedRegistry, themesSeedModule } from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { renderAuthRoute } from "../../apps/user-app/src/auth/route.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { loginContract } from "../../apps/user-app/src/contracts.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "auth_route" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([baseSeedModule, themesSeedModule]),
    });
    await run(database);
  });
}

integrationDescribe("auth route pipeline (ADR 0006)", () => {
  test("renders through the shared pipeline and keeps guest and member shells ETag-free", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const base = {
          sql: database.sql,
          boardName: "Bulletin",
          locale: "en" as const,
          translate,
          template: loginContract.templates.page,
          contract: loginContract,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
        };
        const guest = await renderAuthRoute({
          ...base,
          shell: { visitor: "guest" },
        });
        const member = await renderAuthRoute({
          ...base,
          shell: { visitor: "member" },
        });

        expect(guest.cache).toBe("miss");
        expect(guest.html).toContain("data-login-page");
        // The shell-only difference does not fragment the shared fragment key.
        expect(member.variant).toBe(guest.variant);
        expect(member.cache).toBe("hit");
        expect(member.html).toBe(guest.html);
        // Sign-in responses are no-store and never carry an ETag, so no 304 can retain a shell.
        expect(guest.etag).toBeNull();
        expect(member.etag).toBeNull();
      } finally {
        await versions.close();
      }
    });
  });
});
