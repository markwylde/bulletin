import * as v from "valibot";
import { buildOpenApiDocument } from "./openapi.ts";
import { type ApiRoute, defineApiRoute } from "./route.ts";

const openApiRoute: ApiRoute = defineApiRoute({
  method: "GET",
  path: "/api/v1/openapi.json",
  operationId: "getOpenApiDocument",
  summary: "OpenAPI 3.1 description of this API",
  tags: ["meta"],
  auth: "optional",
  scopes: [],
  cacheControl: "public, max-age=300",
  responses: {
    200: { description: "OpenAPI 3.1 document", schema: v.unknown() },
  },
  handler: (): Response => Response.json(buildOpenApiDocument(API_ROUTES)),
});

/**
 * The `/api/v1` registry. Later endpoint groups append to this list; docs, validation and
 * routing all read the same definitions.
 */
export const API_ROUTES: readonly ApiRoute[] = [openApiRoute];
