import { safeReturnTo } from "./return-to.ts";

export type AuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AuthFetchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StashedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface CreateAuthFetchOptions {
  readonly fetch?: AuthFetch;
  readonly storage?: AuthFetchStorage;
  readonly onReauthRequired?: (request: StashedRequest) => void;
}

const STORAGE_KEY = "bulletin_reauth_request";

function defaultStorage(): AuthFetchStorage | null {
  try {
    const storage = (globalThis as unknown as { localStorage?: AuthFetchStorage }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function describeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): StashedRequest {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.delete("content-length");

  return {
    url: request === null ? String(input) : request.url,
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    headers: Object.fromEntries(headers.entries()),
    body: typeof init?.body === "string" ? init.body : null,
  };
}

/**
 * Wraps fetch so a `reauth_required` response keeps the unsent body locally. The app
 * offers to continue through `/api/auth/refresh` and then resubmit (ADR 0014 drafts).
 */
export function createAuthFetch(options: CreateAuthFetchOptions = {}): AuthFetch {
  const doFetch = options.fetch ?? fetch;
  const storage = options.storage ?? defaultStorage();

  return async (input, init) => {
    const response = await doFetch(input, init);

    if (response.status !== 401) {
      return response;
    }

    const payload = await response
      .clone()
      .json()
      .catch(() => null);

    if (typeof payload !== "object" || payload === null) {
      return response;
    }

    if ((payload as Record<string, unknown>).code !== "reauth_required") {
      return response;
    }

    const stashed = describeRequest(input, init);
    storage?.setItem(STORAGE_KEY, JSON.stringify(stashed));
    options.onReauthRequired?.(stashed);

    return response;
  };
}

export function takeStashedRequest(storage = defaultStorage()): StashedRequest | null {
  const stored = storage?.getItem(STORAGE_KEY);

  if (stored === null || stored === undefined) {
    return null;
  }

  try {
    const value = JSON.parse(stored) as Partial<StashedRequest>;

    if (
      typeof value.url !== "string" ||
      typeof value.method !== "string" ||
      typeof value.headers !== "object" ||
      value.headers === null
    ) {
      return null;
    }

    return {
      url: value.url,
      method: value.method,
      headers: value.headers as Record<string, string>,
      body: typeof value.body === "string" ? value.body : null,
    };
  } catch {
    return null;
  }
}

export function clearStashedRequest(storage = defaultStorage()): void {
  storage?.removeItem(STORAGE_KEY);
}

export function reauthUrl(returnTo: string): string {
  return `/api/auth/refresh?return_to=${encodeURIComponent(safeReturnTo(returnTo) ?? "/")}`;
}
