import { createHash, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type { MockConfig, MockUser } from "./config.ts";
import type { SigningKey } from "./key.ts";

const CODE_TTL_MS = 5 * 60 * 1_000;
const TOKEN_TTL_SECONDS = 5 * 60;
const SSO_COOKIE = "da_user";

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly sub: string;
  readonly expiresAt: number;
}

const EXCLUDED_PARAMS = new Set([
  "user",
  "sub",
  "profile",
  "organization_id",
  "organization_slug",
  "organization_name",
  "roles",
  "permissions",
]);

export interface MockServerOptions {
  readonly config: MockConfig;
  readonly key: SigningKey;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");

  if (header === null) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return null;
}

function corsHeaders(request: Request, config: MockConfig): Record<string, string> {
  const origin = request.headers.get("origin");

  if (origin === null || !config.allowedOrigins.includes(origin)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

function findUser(config: MockConfig, sub: string): MockUser | null {
  return config.users.find((user) => user.sub === sub) ?? null;
}

function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

function page(config: MockConfig, hiddenParams: URLSearchParams): string {
  const hidden = [...hiddenParams.entries()]
    .filter(([name]) => !EXCLUDED_PARAMS.has(name))
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  const cards = config.users
    .map(
      (user) => `<form method="post" action="/authorize/continue" class="card-form">
        ${hidden}
        <input type="hidden" name="user" value="${escapeHtml(user.sub)}">
        <button type="submit" class="card">
          <span class="name">${escapeHtml(user.name)}</span>
          <span class="email">${escapeHtml(user.email)}</span>
        </button>
      </form>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.appName)} — choose an identity</title>
<style>
:root { color-scheme: light; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1rem; background: #eef1f7; color: #1a2333; }
main { width: min(100%, 36rem); padding: 1.5rem; border-radius: 1rem; background: #fff; box-shadow: 0 10px 30px rgb(26 35 51 / 10%); }
h1 { margin: 0 0 1rem; font-size: 1.25rem; }
.cards { display: grid; gap: 0.65rem; }
.card-form { margin: 0; }
.card { width: 100%; display: grid; gap: 0.2rem; padding: 0.85rem 1rem; border: 1px solid #d9e0eb; border-radius: 0.65rem; background: #fff; text-align: left; font: inherit; cursor: pointer; }
.card:hover, .card:focus-visible { border-color: #4b57c4; outline: none; box-shadow: 0 0 0 3px rgb(75 87 196 / 15%); }
.name { font-weight: 700; }
.email { color: #6d7889; font-size: 0.85rem; }
</style>
</head>
<body><main><h1>Choose a local ${escapeHtml(config.appName)} identity</h1><div class="cards">${cards}</div></main></body>
</html>`;
}

export function createMockHandler(
  options: MockServerOptions,
): (request: Request) => Promise<Response> {
  const { config, key } = options;
  const codes = new Map<string, AuthorizationCode>();

  function json(request: Request, body: unknown, status = 200): Response {
    return Response.json(body, {
      status,
      headers: { "cache-control": "no-store", ...corsHeaders(request, config) },
    });
  }

  function html(request: Request, body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        ...corsHeaders(request, config),
      },
    });
  }

  function redirect(request: Request, location: string, cookies: readonly string[] = []): Response {
    const headers = new Headers({
      location,
      "cache-control": "no-store",
      ...corsHeaders(request, config),
    });

    for (const cookie of cookies) {
      headers.append("set-cookie", cookie);
    }

    return new Response(null, { status: 303, headers });
  }

  function authorizedRedirect(params: URLSearchParams, sub: string): string {
    const code = randomUUID();
    const redirectUri = params.get("redirect_uri") ?? "";
    codes.set(code, {
      clientId: params.get("client_id") ?? "",
      redirectUri,
      codeChallenge: params.get("code_challenge") ?? "",
      nonce: params.get("nonce") ?? "",
      sub,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", params.get("state") ?? "");
    return url.toString();
  }

  function errorRedirect(params: URLSearchParams, error: string): string {
    const url = new URL(params.get("redirect_uri") ?? `${config.issuer}/`);
    url.searchParams.set("error", error);
    url.searchParams.set("state", params.get("state") ?? "");
    return url.toString();
  }

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());

    if (form.get("grant_type") !== "authorization_code") {
      return json(request, { error: "unsupported_grant_type" }, 400);
    }

    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code);

    if (
      grant === undefined ||
      grant.expiresAt < Date.now() ||
      form.get("client_id") !== grant.clientId ||
      form.get("redirect_uri") !== grant.redirectUri ||
      !verifyPkce(form.get("code_verifier") ?? "", grant.codeChallenge)
    ) {
      return json(request, { error: "invalid_grant" }, 400);
    }

    const user = findUser(config, grant.sub);

    if (user === null) {
      return json(request, { error: "invalid_grant" }, 400);
    }

    const authTime = Math.floor(Date.now() / 1_000);
    const sid = randomUUID();
    const idToken = await new SignJWT({
      email: user.email,
      email_verified: true,
      name: user.name,
      nonce: grant.nonce,
      auth_time: authTime,
      amr: ["pwd"],
      sid,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer(config.issuer)
      .setAudience(grant.clientId)
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .sign(key.privateKey);
    const accessToken = await new SignJWT({
      email: user.email,
      name: user.name,
      scopes: ["openid", "profile", "email"],
      token_use: "access",
      sid,
    })
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid })
      .setIssuer(config.issuer)
      .setAudience(grant.clientId)
      .setSubject(user.sub)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
      .sign(key.privateKey);

    return json(request, {
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: "openid profile email",
      id_token: idToken,
      access_token: accessToken,
    });
  }

  return async (request) => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request, config),
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
        },
      });
    }

    if (url.pathname === "/.well-known/openid-configuration") {
      return json(request, {
        issuer: config.issuer,
        authorization_endpoint: `${config.issuer}/authorize`,
        token_endpoint: `${config.issuer}/token`,
        jwks_uri: `${config.issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["EdDSA"],
        scopes_supported: ["openid", "profile", "email"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (url.pathname === "/.well-known/jwks.json") {
      return json(request, {
        keys: [{ ...key.publicJwk, kid: key.kid, alg: "EdDSA", use: "sig" }],
      });
    }

    if (url.pathname === "/health") {
      return json(request, { status: "ok" });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204, headers: corsHeaders(request, config) });
    }

    if (url.pathname === "/") {
      return html(
        request,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DarkAuth mock</title></head><body><main><h1>DarkAuth mock</h1><p>Choose an identity from the authorization page.</p></main></body></html>`,
      );
    }

    if (url.pathname === "/authorize" && request.method === "GET") {
      const prompt = url.searchParams.get("prompt");
      const maxAge = url.searchParams.get("max_age");
      const sso = cookieValue(request, SSO_COOKIE);

      if (prompt === "none" && maxAge !== "0") {
        const user = sso === null ? null : findUser(config, sso);
        return user === null
          ? redirect(request, errorRedirect(url.searchParams, "login_required"))
          : redirect(request, authorizedRedirect(url.searchParams, user.sub));
      }

      return html(request, page(config, url.searchParams));
    }

    if (url.pathname === "/authorize/continue" && request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      const user = findUser(config, form.get("user") ?? form.get("sub") ?? "");

      if (user === null) {
        return json(request, { error: "unknown_user" }, 400);
      }

      return redirect(request, authorizedRedirect(form, user.sub), [
        `${SSO_COOKIE}=${encodeURIComponent(user.sub)}; Path=/; HttpOnly; SameSite=Lax`,
      ]);
    }

    if (url.pathname === "/token" && request.method === "POST") {
      return token(request);
    }

    return json(request, { error: "not_found" }, 404);
  };
}
