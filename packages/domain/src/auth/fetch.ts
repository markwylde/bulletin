import { safeReturnTo } from "./return-to.ts";

export type AuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AuthFetchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StashedBody =
  | { readonly kind: "text"; readonly value: string; readonly contentType?: string }
  | { readonly kind: "bytes"; readonly value: string; readonly contentType?: string };

export interface StashedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: StashedBody | null;
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

function isTextual(contentType: string | null): boolean {
  return (
    contentType === null ||
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("x-www-form-urlencoded")
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function bytesBody(bytes: Uint8Array, contentType: string | null): StashedBody {
  return {
    kind: "bytes",
    value: toBase64(bytes),
    ...(contentType === null ? {} : { contentType }),
  };
}

async function snapshotBody(
  body: RequestInit["body"] | null | undefined,
  headers: Headers,
): Promise<StashedBody | null> {
  if (body === null || body === undefined) {
    return null;
  }

  if (typeof body === "string") {
    const contentType = headers.get("content-type");
    return {
      kind: "text",
      value: body,
      ...(contentType === null ? {} : { contentType }),
    };
  }

  if (body instanceof URLSearchParams) {
    const contentType =
      headers.get("content-type") ?? "application/x-www-form-urlencoded;charset=UTF-8";
    headers.set("content-type", contentType);
    return { kind: "text", value: body.toString(), contentType };
  }

  if (body instanceof Blob) {
    const contentType = body.type !== "" ? body.type : headers.get("content-type");
    return bytesBody(new Uint8Array(await body.arrayBuffer()), contentType);
  }

  if (body instanceof ArrayBuffer) {
    return bytesBody(new Uint8Array(body), headers.get("content-type"));
  }

  if (ArrayBuffer.isView(body)) {
    return bytesBody(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      headers.get("content-type"),
    );
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const request = new Request("http://bulletin.invalid/", { method: "POST", body });
    const contentType = request.headers.get("content-type");
    return bytesBody(new Uint8Array(await request.arrayBuffer()), contentType);
  }

  // ReadableStream and other one-shot bodies cannot be replayed faithfully.
  return null;
}

async function snapshotRequest(request: Request, headers: Headers): Promise<StashedBody | null> {
  if (request.body === null) {
    return null;
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  const contentType = headers.get("content-type") ?? request.headers.get("content-type");

  if (isTextual(contentType)) {
    return {
      kind: "text",
      value: new TextDecoder().decode(bytes),
      ...(contentType === null ? {} : { contentType }),
    };
  }

  return bytesBody(bytes, contentType);
}

async function describeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  requestSnapshot: Request | null,
): Promise<StashedRequest> {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init?.headers ?? request?.headers);
  headers.delete("content-length");

  let body: StashedBody | null = null;

  try {
    if (init?.body !== undefined) {
      body = await snapshotBody(init.body, headers);
    } else if (requestSnapshot !== null) {
      body = await snapshotRequest(requestSnapshot, headers);
    }
  } catch {
    body = null;
  }

  if (body?.contentType !== undefined && !headers.has("content-type")) {
    headers.set("content-type", body.contentType);
  }

  return {
    url: request === null ? String(input) : request.url,
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    headers: Object.fromEntries(headers.entries()),
    body,
  };
}

/**
 * Wraps fetch so a `reauth_required` response keeps the unsent body locally. The request is
 * cloned before sending, so `fetch(new Request(...))` and binary/form bodies round-trip.
 */
export function createAuthFetch(options: CreateAuthFetchOptions = {}): AuthFetch {
  const doFetch = options.fetch ?? fetch;
  const storage = options.storage ?? defaultStorage();

  return async (input, init) => {
    const requestSnapshot = input instanceof Request ? (input.clone() as Request) : null;
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

    const stashed = await describeRequest(input, init, requestSnapshot);
    storage?.setItem(STORAGE_KEY, JSON.stringify(stashed));
    options.onReauthRequired?.(stashed);

    return response;
  };
}

function parseStashedBody(value: unknown): StashedBody | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return { kind: "text", value };
  }

  if (typeof value !== "object") {
    return null;
  }

  const body = value as Partial<StashedBody>;

  if (
    (body.kind !== "text" && body.kind !== "bytes") ||
    typeof body.value !== "string" ||
    (body.contentType !== undefined && typeof body.contentType !== "string")
  ) {
    return null;
  }

  return {
    kind: body.kind,
    value: body.value,
    ...(body.contentType === undefined ? {} : { contentType: body.contentType }),
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
      body: parseStashedBody(value.body),
    };
  } catch {
    return null;
  }
}

export function clearStashedRequest(storage = defaultStorage()): void {
  storage?.removeItem(STORAGE_KEY);
}

/** Reconstructs a `BodyInit` for resubmitting a stashed request. */
export function stashedBodyInit(body: StashedBody | null): Exclude<RequestInit["body"], undefined> {
  if (body === null) {
    return null;
  }

  if (body.kind === "text") {
    return body.value;
  }

  const binary = atob(body.value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function reauthUrl(returnTo: string): string {
  return `/api/auth/refresh?return_to=${encodeURIComponent(safeReturnTo(returnTo) ?? "/")}`;
}
