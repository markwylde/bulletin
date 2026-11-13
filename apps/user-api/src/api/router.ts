import {
  combineApiRateLimits,
  consumeApiIpRateLimit,
  consumeApiKeyRateLimit,
  isApiKeyPrincipal,
  markApiKeyUsed,
  missingApiScope,
  resolveApiPrincipal,
} from "@bulletin/domain/api";
import { clientIp } from "@bulletin/domain/auth";
import { readBoardSettings } from "@bulletin/domain/board";
import type { SQL } from "bun";
import { type GenericSchema, safeParse } from "valibot";
import type { ApiRoute } from "./route.ts";

export interface ApiRouterOptions {
  readonly sql: SQL;
  readonly routes: readonly ApiRoute[];
  /** The server pepper for key hashes (ADR 0016). */
  readonly pepper: string;
  /** HMAC key for the rotating per-IP rate-limit identity (ADR 0012). */
  readonly rateLimitSecret: string;
  readonly now?: () => Date;
  /** Evaluates a feature flag for the resolved principal; absent means enabled. */
  readonly isEnabled?: (key: string, memberId: string | null) => Promise<boolean>;
}

const API_PREFIX = "/api/v1";
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After",
};

interface RouteMatch {
  readonly route: ApiRoute;
  readonly params: Readonly<Record<string, string>>;
}

interface MethodMismatch {
  readonly methods: readonly string[];
}

function pathSegments(pathname: string): readonly string[] {
  return pathname.split("/").filter((segment) => segment !== "");
}

function matchPath(pattern: string, pathname: string): Readonly<Record<string, string>> | null {
  const expected = pathSegments(pattern);
  const actual = pathSegments(pathname);

  if (expected.length !== actual.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (const [index, part] of expected.entries()) {
    const value = actual[index] ?? "";

    if (part.startsWith(":")) {
      if (value === "") {
        return null;
      }

      params[part.slice(1)] = decodeURIComponent(value);
      continue;
    }

    if (part !== value) {
      return null;
    }
  }

  return params;
}

function findRoute(
  routes: readonly ApiRoute[],
  method: string,
  pathname: string,
): RouteMatch | MethodMismatch | null {
  const allowed = new Set<string>();

  for (const route of routes) {
    const params = matchPath(route.path, pathname);

    if (params === null) {
      continue;
    }

    if (route.method === method) {
      return { route, params };
    }

    allowed.add(route.method);
  }

  return allowed.size === 0 ? null : { methods: [...allowed] };
}

function queryValues(url: URL): Readonly<Record<string, string | string[]>> {
  const values: Record<string, string | string[]> = {};

  for (const [key, value] of url.searchParams) {
    const existing = values[key];

    if (existing === undefined) {
      values[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      values[key] = [existing, value];
    }
  }

  return values;
}

interface ValidationFailure {
  readonly path: string;
  readonly message: string;
}

interface IssueLike {
  readonly message?: string;
  readonly path?: readonly ({ readonly key?: unknown } | undefined)[] | undefined;
}

function validationFailure(error: {
  readonly issues: readonly IssueLike[];
}): readonly ValidationFailure[] {
  return error.issues.map((issue) => ({
    path: (issue.path ?? [])
      .map((entry) => (typeof entry?.key === "string" ? entry.key : String(entry?.key ?? "")))
      .filter((part) => part !== "")
      .join("."),
    message: issue.message ?? "invalid",
  }));
}

function parseWith(
  schema: GenericSchema | undefined,
  value: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly ValidationFailure[] } {
  if (schema === undefined) {
    return { ok: true, value };
  }

  const result = safeParse(schema, value);

  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, issues: validationFailure(result) };
}

async function jsonBody(
  request: Request,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const text = await request.text();

  if (text.trim() === "") {
    return { ok: true, value: undefined };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function withHeaders(
  response: Response,
  headers: Readonly<Record<string, string>>,
  cacheControl: string,
): Response {
  const merged = new Headers(response.headers);

  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    merged.set(name, value);
  }

  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }

  if (!merged.has("cache-control")) {
    merged.set("cache-control", cacheControl);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function errorResponse(
  status: number,
  code: string,
  headers: Readonly<Record<string, string>> = {},
  details?: readonly ValidationFailure[],
): Response {
  const body = details === undefined ? { code } : { code, issues: details };

  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, ...headers, "cache-control": "no-store" },
  });
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, If-None-Match",
      "access-control-max-age": "600",
      "cache-control": "no-store",
    },
  });
}

/**
 * Serves `/api/v1`. This runs before the app's session middleware so cookies cannot
 * authenticate here, and it is the only place an API key is accepted (ADR 0016, 0018).
 */
export async function handleApiRequest(
  request: Request,
  options: ApiRouterOptions,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
    return null;
  }

  if (request.method === "OPTIONS") {
    return preflight();
  }

  const match = findRoute(options.routes, request.method, url.pathname);

  if (match === null) {
    return errorResponse(404, "not_found");
  }

  if ("methods" in match) {
    return errorResponse(405, "method_not_allowed", {
      allow: match.methods.join(", "),
    });
  }

  const now = options.now?.() ?? new Date();
  const settings = await readBoardSettings(options.sql);
  // IP throttling runs before authentication, so a stream of invalid keys is still counted.
  const ipRate = await consumeApiIpRateLimit(options.sql, {
    ip: clientIp(request),
    secret: options.rateLimitSecret,
    limit: settings.apiIpRateLimitPerMinute,
    now,
  });

  if (!ipRate.allowed) {
    return errorResponse(429, "rate_limited", {
      ...ipRate.headers,
      "retry-after": String(ipRate.retryAfterSeconds),
    });
  }

  let limitHeaders = ipRate.headers;
  // Bun's Request type and the DOM Request type differ only in header augmentation; the
  // handler gets an unconsumed clone so it can call an app response helper that reads JSON.
  const handlerRequest = request.clone() as unknown as Request;
  const auth = await resolveApiPrincipal(options.sql, request, {
    pepper: options.pepper,
    now,
  });

  if (!auth.ok) {
    return errorResponse(401, auth.code, {
      ...limitHeaders,
      "www-authenticate": "Bearer",
    });
  }

  const { principal, route } = { principal: auth.principal, route: match.route };

  const enabled =
    options.isEnabled === undefined ||
    (await options.isEnabled(
      "public_api",
      isApiKeyPrincipal(principal) ? principal.memberId : null,
    ));

  if (!enabled) {
    return errorResponse(404, "not_found", limitHeaders);
  }

  if (route.auth === "required" && !isApiKeyPrincipal(principal)) {
    return errorResponse(401, "unauthenticated", {
      ...limitHeaders,
      "www-authenticate": "Bearer",
    });
  }

  if (isApiKeyPrincipal(principal)) {
    const keyRate = await consumeApiKeyRateLimit(options.sql, {
      keyId: principal.keyId,
      secret: options.rateLimitSecret,
      limit: settings.apiKeyRateLimitPerMinute,
      now,
    });

    limitHeaders = combineApiRateLimits([ipRate, keyRate]).headers;

    if (!keyRate.allowed) {
      return errorResponse(429, "rate_limited", {
        ...limitHeaders,
        "retry-after": String(keyRate.retryAfterSeconds),
      });
    }

    const missing = missingApiScope(principal, route.scopes);

    if (missing !== null) {
      return errorResponse(403, "insufficient_scope", {
        ...limitHeaders,
        "www-authenticate": `Bearer error="insufficient_scope", scope="${route.scopes.join(" ")}"`,
      });
    }

    await markApiKeyUsed(options.sql, principal.keyId, now);
  }

  const [params, body] = await Promise.all([
    Promise.resolve(parseWith(route.params, match.params)),
    jsonBody(request),
  ]);

  if (!params.ok) {
    return errorResponse(400, "validation_failed", limitHeaders, params.issues);
  }

  if (!body.ok) {
    return errorResponse(400, "invalid_json", limitHeaders);
  }

  const query = parseWith(route.query, queryValues(url));
  const parsedBody = parseWith(route.body, body.value);

  if (!query.ok) {
    return errorResponse(400, "validation_failed", limitHeaders, query.issues);
  }

  if (!parsedBody.ok) {
    return errorResponse(400, "validation_failed", limitHeaders, parsedBody.issues);
  }

  let response: Response;

  try {
    response = await route.handler({
      request: handlerRequest,
      url,
      sql: options.sql,
      principal,
      params: params.value,
      query: query.value,
      body: parsedBody.value,
      now,
    });
  } catch {
    return errorResponse(500, "internal_error", limitHeaders);
  }

  return withHeaders(response, limitHeaders, route.cacheControl ?? "no-store");
}
