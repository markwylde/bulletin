import { type Catalog, createMarketplaceHandler, signCatalog } from "./app.ts";
import { buildThemePackages } from "./packages.ts";

const port = Number(Bun.env.PORT ?? 4007);
const packages = await buildThemePackages();
const catalog: Catalog = {
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  packages: packages.map((entry) => entry.package),
};
const signed = await signCatalog(catalog);

Bun.serve({ port, fetch: createMarketplaceHandler(catalog, signed, packages) });

console.log(`mock-marketplace listening on http://localhost:${port}`);
