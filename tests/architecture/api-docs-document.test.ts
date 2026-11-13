import { describe, expect, test } from "bun:test";
import { buildOpenApiDocument } from "../../apps/user-api/src/api/openapi.ts";
import { API_ROUTES } from "../../apps/user-api/src/api/routes.ts";
import embedded from "../../apps/user-app/src/api-docs/openapi.json";

// Task 2.3: `/api-docs` embeds the document in the island props instead of fetching it, so a
// `public_api` rollout that is on for Members and off for Guests still renders the schema.
// The committed copy is what user-app ships; it must match what user-api serves.
describe("API docs document", () => {
  test("the document embedded by user-app matches the route registry", () => {
    expect(embedded).toEqual(buildOpenApiDocument(API_ROUTES));
  });
});
