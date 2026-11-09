import { escapeHtml, htmlResponse, jsonResponse, renderPage } from "@bulletin/mock-ui";
import { CompactSign, importJWK } from "jose";
import { DEV_KEY_ID, DEV_PRIVATE_KEY, DEV_PUBLIC_KEY } from "./keys.ts";

export interface Catalog {
  readonly version: 1;
  readonly generatedAt: string;
  readonly packages: readonly unknown[];
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
