import { type Catalog, createMarketplaceHandler, signCatalog } from "./app.ts";

const port = Number(Bun.env.PORT ?? 4007);
const catalog: Catalog = {
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  packages: [],
};
const signed = await signCatalog(catalog);

Bun.serve({ port, fetch: createMarketplaceHandler(catalog, signed) });

console.log(`mock-marketplace listening on http://localhost:${port}`);
