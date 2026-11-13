import type { ApiPrincipal, ApiScope } from "@bulletin/domain/api";
import type { SQL } from "bun";
import type * as v from "valibot";

export type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiRequestContext<TParams = undefined, TQuery = undefined, TBody = undefined> {
  readonly request: Request;
  readonly url: URL;
  readonly sql: SQL;
  readonly principal: ApiPrincipal;
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly now: Date;
}

type SchemaOutput<T> = T extends v.GenericSchema<unknown, infer Output> ? Output : undefined;

export interface ApiResponseDefinition {
  readonly description: string;
  readonly schema?: v.GenericSchema;
}

export interface ApiRoute {
  readonly method: ApiMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  /** `required` rejects guests; `optional` lets a key refine a public read. */
  readonly auth: "required" | "optional";
  readonly scopes: readonly ApiScope[];
  readonly params?: v.GenericSchema;
  readonly query?: v.GenericSchema;
  readonly body?: v.GenericSchema;
  readonly responses: Readonly<Record<number, ApiResponseDefinition>>;
  readonly cacheControl?: string;
  readonly handler: (
    context: ApiRequestContext<unknown, unknown, unknown>,
  ) => Promise<Response> | Response;
}

export interface ApiRouteDefinition<
  TParams extends v.GenericSchema | undefined,
  TQuery extends v.GenericSchema | undefined,
  TBody extends v.GenericSchema | undefined,
> {
  readonly method: ApiMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly auth: "required" | "optional";
  readonly scopes: readonly ApiScope[];
  readonly params?: TParams;
  readonly query?: TQuery;
  readonly body?: TBody;
  readonly responses: Readonly<Record<number, ApiResponseDefinition>>;
  readonly cacheControl?: string;
  readonly handler: (
    context: ApiRequestContext<SchemaOutput<TParams>, SchemaOutput<TQuery>, SchemaOutput<TBody>>,
  ) => Promise<Response> | Response;
}

/**
 * Declares one `/api/v1` route. The same valibot schemas validate the request and generate the
 * OpenAPI document, so documentation cannot drift from the accepted input (ADR 0016).
 */
export function defineApiRoute<
  TParams extends v.GenericSchema | undefined,
  TQuery extends v.GenericSchema | undefined,
  TBody extends v.GenericSchema | undefined,
>(definition: ApiRouteDefinition<TParams, TQuery, TBody>): ApiRoute {
  const { handler, params, query, body, cacheControl, ...route } = definition;

  return {
    ...route,
    ...(params === undefined ? {} : { params }),
    ...(query === undefined ? {} : { query }),
    ...(body === undefined ? {} : { body }),
    ...(cacheControl === undefined ? {} : { cacheControl }),
    handler: (context) =>
      handler(
        context as unknown as ApiRequestContext<
          SchemaOutput<TParams>,
          SchemaOutput<TQuery>,
          SchemaOutput<TBody>
        >,
      ),
  };
}
