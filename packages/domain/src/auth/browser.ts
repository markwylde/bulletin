import {
  bytesToBase64Url,
  handleCallback as exchangeAuthorizationCode,
  setConfig,
  sha256,
} from "@darkauth/client";
import { safeReturnTo } from "./return-to.ts";

export interface BrowserChallenge {
  readonly state: string;
  readonly nonce: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnTo: string | null;
}

export interface BrowserSessionView {
  readonly authenticated: boolean;
  readonly csrfToken: string | null;
  readonly displayName: string | null;
  readonly displayNameRequired: boolean;
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
  const returnTo = options.returnTo ?? `${browser.location.pathname}${browser.location.search}`;
  const response = await fetch(options.challengeUrl ?? "/api/auth/challenge", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ returnTo }),
  });

  if (!response.ok) {
    throw new Error("Could not start the login challenge");
  }

  const challenge = (await response.json()) as BrowserChallenge;
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
  browser.location.assign(authorizeUrl.toString());
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

/** The callback transit route: exchange, post the ID token, then return to the page. */
export async function finishLoginAndRedirect(): Promise<void> {
  const { returnTo, idToken } = await finishLogin();
  await submitIdToken(idToken);
  browser.location.replace(returnTo);
}

export async function loadSession(): Promise<BrowserSessionView> {
  const response = await fetch("/api/auth/session", {
    credentials: "include",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error("Could not read the session");
  }

  return (await response.json()) as BrowserSessionView;
}
