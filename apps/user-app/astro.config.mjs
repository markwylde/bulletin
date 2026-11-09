import { assertConnectionBudget, parseReplicas } from "@bulletin/config/connections";
import { defineConfig } from "astro/config";

// The SSR adapter is chosen by spike S1 (ADR 0008); the shell builds statically for now.
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
  output: "static",
  // The dev toolbar injects a nonce-less inline script, which the strict CSP blocks.
  devToolbar: { enabled: false },
  integrations: [budgetGuard],
});
