import node from "@astrojs/node";
import { assertConnectionBudget, parseReplicas } from "@bulletin/config/connections";
import { defineConfig } from "astro/config";

// Spike S1 pinned Astro's official Node adapter in standalone mode, run by Bun (ADR 0008);
// the community Bun adapters are either incompatible with Astro 7 or need Bun 1.4.4+.
const adapter = node({ mode: "standalone" });

const budgetGuard = {
  name: "bulletin-budget-guard",
  hooks: {
    "astro:config:setup": async ({ command }) => {
      if (command !== "dev") {
        return;
      }

      const databaseUrl = process.env.DATABASE_URL ?? "postgres://user_app@postgres:5432/bulletin";
      const probe = new Bun.SQL(databaseUrl, { max: 1, connectionTimeout: 5 });

      try {
        const rows = await probe`SHOW max_connections`;
        const maxConnections = Number(rows[0]?.max_connections ?? 0);
        assertConnectionBudget({
          maxConnections,
          replicas: parseReplicas(process.env.BULLETIN_REPLICAS),
        });
      } finally {
        await probe.close();
      }
    },
  },
};

export default defineConfig({
  output: "server",
  adapter,
  // Bun's SQL client is a runtime global in the SSR build; never bundle it.
  vite: { ssr: { external: ["bun"] } },
  // The dev toolbar injects a nonce-less inline script, which the strict CSP blocks.
  devToolbar: { enabled: false },
  integrations: [budgetGuard],
});
