export type OidcErrorKind = "network" | "denied";

export class OidcError extends Error {
  readonly kind: OidcErrorKind;

  constructor(message: string, kind: OidcErrorKind) {
    super(message);
    this.name = "OidcError";
    this.kind = kind;
  }
}

export interface TokenExchangeOptions {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Exchanges an authorization code using the server-held PKCE verifier. */
export async function exchangeAuthorizationCode(
  options: TokenExchangeOptions,
): Promise<{ readonly idToken: string }> {
  const doFetch = options.fetch ?? fetch;

  let response: Response;

  try {
    response = await doFetch(options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: options.code,
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        code_verifier: options.codeVerifier,
      }),
    });
  } catch {
    throw new OidcError("The identity provider could not be reached", "network");
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new OidcError(
      "The identity provider rejected the authorization code",
      response.status >= 500 ? "network" : "denied",
    );
  }

  if (body === null || typeof body !== "object") {
    throw new OidcError("The identity provider returned an invalid token response", "denied");
  }

  const idToken = (body as Record<string, unknown>).id_token;

  if (typeof idToken !== "string" || idToken === "") {
    throw new OidcError("The identity provider returned no ID token", "denied");
  }

  return { idToken };
}
