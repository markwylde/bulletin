import {
  bytesToBase64Url,
  handleCallback as exchangeAuthorizationCode,
  setConfig,
  sha256,
} from "@darkauth/client";
import { type AuthFetch, clearStashedRequest } from "./fetch.ts";
import { safeReturnTo } from "./return-to.ts";

export {
  type AuthFetch,
  clearStashedRequest,
  createAuthFetch,
  reauthUrl,
  type StashedRequest,
  stashedBodyInit,
  takeStashedRequest,
} from "./fetch.ts";
export { reauthRedirectUrl, shouldRedirectToReauth } from "./silent.ts";

export interface BrowserChallenge {
  readonly state: string;
  readonly nonce: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnTo: string | null;
  readonly maxAge: number | null;
}

export interface BrowserSessionView {
  readonly authenticated: boolean;
  readonly csrfToken: string | null;
  readonly memberId: string | null;
  readonly displayName: string | null;
  readonly displayNameRequired: boolean;
  readonly locale: "en" | "es" | "fr" | null;
  readonly reauthAt: string | null;
  readonly kind: "user" | "staff";
}

export interface CompletedLogin {
  readonly returnTo: string;
  readonly idToken: string;
}

const STATE_KEY = "oauth_state";
const VERIFIER_KEY = "pkce_verifier";
const CONFIG_KEY = "bulletin_auth_config";
const RETURN_TO_KEY = "bulletin_return_to";
export const CSRF_STORAGE_KEY = "bulletin_csrf_token";

interface BrowserGlobals {
  readonly location: {
    readonly pathname: string;
    readonly search: string;
    assign(url: string): void;
    replace(url: string): void;
  };
  readonly sessionStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
}

const browser = globalThis as unknown as BrowserGlobals;

function storeConfig(challenge: BrowserChallenge): void {
  browser.sessionStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({
      issuer: challenge.issuer,
      clientId: challenge.clientId,
      redirectUri: challenge.redirectUri,
    }),
  );
}

function loadConfig(): { issuer: string; clientId: string; redirectUri: string } {
  const stored = browser.sessionStorage.getItem(CONFIG_KEY);

  if (stored === null) {
    throw new Error("Missing login configuration");
  }

  return JSON.parse(stored) as { issuer: string; clientId: string; redirectUri: string };
}

async function requestChallenge(
  body: Record<string, unknown>,
  challengeUrl: string,
): Promise<BrowserChallenge> {
  const response = await fetch(challengeUrl, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error("Could not start the login challenge");
  }

  return (await response.json()) as BrowserChallenge;
}

async function startAuthorization(challenge: BrowserChallenge): Promise<void> {
  const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = bytesToBase64Url(await sha256(new TextEncoder().encode(verifier)));

  browser.sessionStorage.setItem(STATE_KEY, challenge.state);
  browser.sessionStorage.setItem(VERIFIER_KEY, verifier);
  browser.sessionStorage.setItem(RETURN_TO_KEY, safeReturnTo(challenge.returnTo) ?? "/");
  storeConfig(challenge);

  const authorizeUrl = new URL(`${challenge.issuer}/authorize`);
  authorizeUrl.searchParams.set("client_id", challenge.clientId);
  authorizeUrl.searchParams.set("redirect_uri", challenge.redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid profile email");
  authorizeUrl.searchParams.set("state", challenge.state);
  authorizeUrl.searchParams.set("nonce", challenge.nonce);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  if (challenge.maxAge !== null) {
    authorizeUrl.searchParams.set("max_age", String(challenge.maxAge));
  }

  browser.location.assign(authorizeUrl.toString());
}

async function startLogin(options: {
  readonly challengeUrl?: string;
  readonly returnTo?: string;
  readonly maxAge?: 0;
}): Promise<void> {
  const returnTo = options.returnTo ?? `${browser.location.pathname}${browser.location.search}`;
  const body: Record<string, unknown> = { returnTo };

  if (options.maxAge !== undefined) {
    body.maxAge = options.maxAge;
  }

  const challenge = await requestChallenge(body, options.challengeUrl ?? "/api/auth/challenge");
  await startAuthorization(challenge);
}

/**
 * Starts a server-bound login (ADR 0018): the API issues the single-use challenge and
 * nonce, the browser generates the PKCE verifier and redirects to DarkAuth. The
 * `@darkauth/client` keys are used so its callback handler can complete the exchange.
 *
 * `initiateLogin()` is not used because the client generates its own state and sends no
 * nonce; the server-bound challenge must own both. Its callback handler still performs the
 * PKCE exchange and returns the ID token for `/api/auth/session`.
 */
export async function beginLogin(
  options: { readonly challengeUrl?: string; readonly returnTo?: string } = {},
): Promise<void> {
  await startLogin(options);
}

/** Starts a step-up challenge with `max_age=0` for a sensitive staff action. */
export async function beginStepUp(
  options: { readonly challengeUrl?: string; readonly returnTo?: string } = {},
): Promise<void> {
  await startLogin({ ...options, maxAge: 0 });
}

/** Completes the code exchange through `@darkauth/client` and yields the ID token. */
export async function finishLogin(): Promise<CompletedLogin> {
  const config = loadConfig();
  setConfig({
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scope: "openid profile email",
    zk: false,
    firstParty: true,
    tokenStorage: "memory",
  });

  const session = await exchangeAuthorizationCode();

  if (session === null) {
    throw new Error("Missing authorization code");
  }

  const returnTo = safeReturnTo(browser.sessionStorage.getItem(RETURN_TO_KEY)) ?? "/";
  browser.sessionStorage.removeItem(CONFIG_KEY);
  browser.sessionStorage.removeItem(RETURN_TO_KEY);

  return { returnTo, idToken: session.idToken };
}

export async function submitIdToken(idToken: string): Promise<void> {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });

  if (!response.ok) {
    throw new Error("The session endpoint rejected the ID token");
  }
}

let loginCompletion: Promise<void> | undefined;

/**
 * The callback transit route: exchange, post the ID token, then return to the page.
 * Single-flight: React StrictMode runs the callback effect twice, and the login challenge
 * is single-use, so only one POST may be made.
 */
export function finishLoginAndRedirect(): Promise<void> {
  loginCompletion ??= (async () => {
    const { returnTo, idToken } = await finishLogin();
    await submitIdToken(idToken);
    browser.location.replace(returnTo);
  })();

  return loginCompletion;
}

export class ReauthRequiredError extends Error {
  constructor() {
    super("Session re-authentication required");
    this.name = "ReauthRequiredError";
  }
}

export async function loadSession(): Promise<BrowserSessionView> {
  const response = await fetch("/api/auth/session", {
    credentials: "include",
    headers: { accept: "application/json" },
  });

  if (response.status === 401) {
    const payload = await response
      .clone()
      .json()
      .catch(() => null);

    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as Record<string, unknown>).code === "reauth_required"
    ) {
      const csrfToken = (payload as Record<string, unknown>).csrfToken;

      if (typeof csrfToken === "string") {
        browser.sessionStorage.setItem(CSRF_STORAGE_KEY, csrfToken);
      }

      throw new ReauthRequiredError();
    }
  }

  if (!response.ok) {
    throw new Error("Could not read the session");
  }

  const session = (await response.json()) as BrowserSessionView;

  if (session.csrfToken !== null) {
    browser.sessionStorage.setItem(CSRF_STORAGE_KEY, session.csrfToken);
  } else {
    browser.sessionStorage.removeItem(CSRF_STORAGE_KEY);
  }

  return session;
}

export interface LogoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LogoutDependencies {
  readonly fetch: AuthFetch;
  readonly storage: LogoutStorage;
  readonly redirect: (url: string) => void;
  readonly clearStashed: () => void;
}

/**
 * Revokes the server session, using the CSRF token seen on the last authenticated response.
 * The session bootstrap may already be 401 after the re-auth grace, but the token remains
 * valid for this session; the 401 body repeats it when a fresh tab has no cached copy.
 */
export async function performLogout(dependencies: LogoutDependencies): Promise<boolean> {
  let csrfToken = dependencies.storage.getItem(CSRF_STORAGE_KEY);

  try {
    const sessionResponse = await dependencies.fetch("/api/auth/session", {
      credentials: "include",
      headers: { accept: "application/json" },
    });

    if (sessionResponse.status === 401) {
      const payload = await sessionResponse
        .clone()
        .json()
        .catch(() => null);
      const provided =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).csrfToken
          : null;

      if (typeof provided === "string") {
        csrfToken = provided;
        dependencies.storage.setItem(CSRF_STORAGE_KEY, provided);
      }
    } else if (sessionResponse.ok) {
      const session = (await sessionResponse.json()) as BrowserSessionView;

      if (session.csrfToken !== null) {
        csrfToken = session.csrfToken;
        dependencies.storage.setItem(CSRF_STORAGE_KEY, session.csrfToken);
      }
    }
  } catch {
    // Keep the cached token; the logout POST below decides the outcome.
  }

  const headers: Record<string, string> = { "content-type": "application/json" };

  if (csrfToken !== null) {
    headers["x-bulletin-csrf"] = csrfToken;
  }

  let response: Response;

  try {
    response = await dependencies.fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers,
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    return false;
  }

  dependencies.storage.removeItem(CSRF_STORAGE_KEY);
  dependencies.clearStashed();
  dependencies.redirect("/");
  return true;
}

/** Logout clears local data only after the server has confirmed revocation (ADR 0018). */
export function logout(): Promise<boolean> {
  return performLogout({
    fetch,
    storage: browser.sessionStorage,
    redirect: (url) => browser.location.replace(url),
    clearStashed: () => clearStashedRequest(),
  });
}
