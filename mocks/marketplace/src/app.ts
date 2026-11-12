import { escapeHtml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";
import { CompactSign, importJWK } from "jose";
import { DEV_KEY_ID, DEV_PRIVATE_KEY, DEV_PUBLIC_KEY } from "./keys.ts";
import type { CatalogPackage, MarketplacePackage } from "./packages.ts";

export interface Catalog {
  readonly version: 1;
  readonly generatedAt: string;
  readonly packages: readonly CatalogPackage[];
}

export async function signCatalog(catalog: Catalog): Promise<string> {
  const key = await importJWK(DEV_PRIVATE_KEY, "EdDSA");

  return new CompactSign(new TextEncoder().encode(JSON.stringify(catalog)))
    .setProtectedHeader({ alg: "EdDSA", kid: DEV_KEY_ID })
    .sign(key);
}

export function createMarketplaceHandler(
  catalog: Catalog,
  signedCatalog: string,
  packages: readonly MarketplacePackage[] = [],
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", packages: catalog.packages.length });
    }

    if (url.pathname === "/keys.json") {
      return jsonResponse({ keys: [DEV_PUBLIC_KEY] });
    }

    if (url.pathname === "/catalog.jws") {
      return new Response(signedCatalog, {
        headers: { "content-type": "application/jose", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/catalog.json") {
      return jsonResponse(catalog);
    }

    const bundle = /^\/packages\/([a-z0-9_-]+)\.(tar|sig)$/.exec(url.pathname);
    const themePackage = packages.find((entry) => entry.package.id === bundle?.[1]);

    if (bundle !== null && themePackage !== undefined) {
      if (bundle[2] === "tar") {
        return new Response(themePackage.bundle, {
          headers: { "content-type": "application/x-tar", "cache-control": "no-store" },
        });
      }

      return new Response(themePackage.signature, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname !== "/" && url.pathname !== "") {
      return new Response("Not found", { status: 404 });
    }

    return htmlResponse(
      renderPage(
        "Marketplace mock",
        `<div class="panel">
          <p>The signed empty catalogue is served at <code>/catalog.jws</code>.
          The development public key is at <code>/keys.json</code>.</p>
          <h2>Catalogue payload</h2>
          <pre>${escapeHtml(JSON.stringify(catalog, null, 2))}</pre>
          <h2>Signature</h2>
          <pre>${escapeHtml(signedCatalog)}</pre>
        </div>`,
      ),
    );
  };
}
