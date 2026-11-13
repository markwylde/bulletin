/**
 * Generates the OpenAPI 3.1 document user-app embeds in `/api-docs` (ADR 0016, change
 * `public-api-webhooks`). user-api builds the served document from the same registry at load
 * time; this script copies it into user-app's source tree so the docs page never has to fetch
 * it. `bun run openapi:check` (part of `bun run check`) fails when the copy is stale.
 */

import { buildOpenApiDocument } from "../apps/user-api/src/api/openapi.ts";
import { API_ROUTES } from "../apps/user-api/src/api/routes.ts";

export const OPENAPI_DOCUMENT_PATH = new URL(
  "../apps/user-app/src/api-docs/openapi.json",
  import.meta.url,
);

/** The document exactly as it is committed and embedded in the page. */
export function renderedOpenApiDocument(): string {
  return `${JSON.stringify(buildOpenApiDocument(API_ROUTES), null, 2)}\n`;
}

const write = process.argv.includes("--write");
const document = renderedOpenApiDocument();

if (write) {
  await Bun.write(OPENAPI_DOCUMENT_PATH, document);
  console.log(`openapi: wrote ${OPENAPI_DOCUMENT_PATH.pathname}`);
} else {
  const committed = await Bun.file(OPENAPI_DOCUMENT_PATH)
    .text()
    .catch(() => "");

  if (committed !== document) {
    console.error(
      "openapi: apps/user-app/src/api-docs/openapi.json is stale; run `bun run openapi:build`",
    );
    process.exit(1);
  }

  console.log("openapi: document OK");
}
