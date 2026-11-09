import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isBlockedAddress } from "./address.ts";

export type SafeFetchErrorCode =
  | "invalid_url"
  | "https_required"
  | "dev_allowlist_forbidden"
  | "dns_error"
  | "blocked_address"
  | "too_many_redirects"
  | "body_too_large"
  | "timeout"
  | "aborted"
  | "unsupported_body"
  | "network";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;

  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type SafeBody = string | Uint8Array | ArrayBuffer | URLSearchParams | Blob;

export interface SafeFetchRequestInit extends Omit<RequestInit, "body" | "redirect"> {
  readonly body?: SafeBody | null;
}

export interface SafeFetchConfig {
  readonly nodeEnv?: "development" | "test" | "production";
  /** Dev-only hostnames that may resolve to private addresses (ADR 0016). */
  readonly devAllow?: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly resolve?: Resolver;
}

export type SafeFetch = (input: string | URL, init?: SafeFetchRequestInit) => Promise<Response>;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

function abortError(): SafeFetchError {
  return new SafeFetchError("aborted", "Request was aborted");
}

function toHeaders(source: RequestInit["headers"] | undefined): Headers {
  return new Headers(source);
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(name, item);
      }
    } else {
      result.set(name, value);
    }
  }

  return result;
}

async function bodyBuffer(body: SafeBody | null | undefined): Promise<Buffer | undefined> {
  if (body === null || body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    return Buffer.from(body);
  }

  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString());
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(body));
  }

  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }

  throw new SafeFetchError("unsupported_body", "Unsupported request body type");
}

function requestOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  pinned: ResolvedAddress,
  options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const fail = (error: SafeFetchError): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      request.destroy();
      reject(error);
    };

    const secure = url.protocol === "https:";
    const request = (secure ? httpsRequest : httpRequest)(
      {
        hostname: pinned.address,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent: false,
        ...(secure ? { servername: url.hostname.replace(/^\[|\]$/g, "") } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          if (settled) {
            return;
          }

          size += chunk.byteLength;

          if (size > options.maxBytes) {
            fail(
              new SafeFetchError(
                "body_too_large",
                `Response exceeds the ${options.maxBytes} byte cap`,
              ),
            );
            return;
          }

          chunks.push(chunk);
        });

        response.on("end", () => {
          if (settled) {
            return;
          }

          const status = response.statusCode ?? 0;

          try {
            const bodyless = status === 204 || status === 205 || status === 304;
            const result = new Response(bodyless ? null : Buffer.concat(chunks), {
              status,
              headers: responseHeaders(response.headers),
            });

            if (settled) {
              return;
            }

            settled = true;
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            resolve(result);
          } catch (error) {
            settled = true;
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            reject(
              new SafeFetchError("network", error instanceof Error ? error.message : String(error)),
            );
          }
        });

        response.on("error", (error) => {
          fail(new SafeFetchError("network", error.message));
        });
      },
    );

    request.on("error", (error) => {
      fail(error instanceof SafeFetchError ? error : new SafeFetchError("network", error.message));
    });

    timer = setTimeout(() => {
      fail(new SafeFetchError("timeout", `Request exceeded ${options.timeoutMs} ms`));
    }, options.timeoutMs);

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        fail(abortError());
        return;
      }

      options.signal.addEventListener("abort", () => fail(abortError()), { once: true });
    }

    if (body !== undefined) {
      request.write(body);
    }

    request.end();
  });
}

async function resolveAddresses(
  url: URL,
  config: {
    readonly devAllow: ReadonlySet<string>;
    readonly resolve: Resolver;
  },
): Promise<ResolvedAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const literal = isIP(hostname);
  const allowlisted = config.devAllow.has(hostname) || config.devAllow.has(url.host);
  let addresses: readonly ResolvedAddress[];

  if (literal !== 0) {
    addresses = [{ address: hostname, family: literal }];
  } else {
    try {
      addresses = await config.resolve(hostname);
    } catch (error) {
      throw new SafeFetchError(
        "dns_error",
        `Could not resolve ${hostname}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  if (addresses.length === 0) {
    throw new SafeFetchError("dns_error", `No addresses resolved for ${hostname}`);
  }

  if (!allowlisted) {
    for (const address of addresses) {
      if (isBlockedAddress(address.address)) {
        throw new SafeFetchError(
          "blocked_address",
          `Blocked address ${address.address} for ${hostname}`,
        );
      }
    }
  }

  return addresses[0] as ResolvedAddress;
}

/** Creates a fetch implementation that pins DNS, blocks private ranges and caps work. */
export function createSafeFetch(config: SafeFetchConfig = {}): SafeFetch {
  const nodeEnv =
    config.nodeEnv ?? (Bun.env.NODE_ENV === "production" ? "production" : "development");
  const devAllow = new Set(
    (config.devAllow ?? [])
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  );

  if (nodeEnv === "production" && devAllow.size > 0) {
    throw new SafeFetchError(
      "dev_allowlist_forbidden",
      "SAFE_FETCH_DEV_ALLOW is not allowed when NODE_ENV=production",
    );
  }

  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = config.maxRedirects ?? 0;
  const resolve = config.resolve ?? defaultResolver;

  const execute = async (
    url: URL,
    init: SafeFetchRequestInit,
    redirectsLeft: number,
  ): Promise<Response> => {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SafeFetchError("invalid_url", `Unsupported protocol ${url.protocol}`);
    }

    if (nodeEnv === "production" && url.protocol !== "https:") {
      throw new SafeFetchError("https_required", "HTTPS is required in production");
    }

    const startedAt = Date.now();
    const remainingMs = (): number => Math.max(0, timeoutMs - (Date.now() - startedAt));

    const resolution = resolveAddresses(url, { devAllow, resolve });
    // A resolver that never settles must not outlive the caller's deadline.
    resolution.catch(() => undefined);

    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SafeFetchError("timeout", `DNS resolution exceeded ${timeoutMs} ms`));
      }, remainingMs());

      void resolution.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer),
      );
    });

    const abort = init.signal
      ? new Promise<never>((_resolve, reject) => {
          if (init.signal?.aborted === true) {
            reject(abortError());
            return;
          }

          init.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
        })
      : null;

    const pinned = await Promise.race([resolution, deadline, ...(abort === null ? [] : [abort])]);
    const requestTimeoutMs = remainingMs();

    if (requestTimeoutMs <= 0) {
      throw new SafeFetchError("timeout", `Request exceeded ${timeoutMs} ms`);
    }

    const body = await bodyBuffer(init.body);
    const headers = toHeaders(init.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.set("host", url.host);

    if (body !== undefined) {
      headers.set("content-length", String(body.byteLength));
    }

    const method = (init.method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
    const response = await requestOnce(
      url,
      method,
      Object.fromEntries(headers.entries()),
      body,
      pinned,
      {
        maxBytes,
        timeoutMs: requestTimeoutMs,
        ...(init.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      },
    );

    if (response.status >= 300 && response.status < 400 && maxRedirects > 0) {
      const location = response.headers.get("location");

      if (location === null) {
        return response;
      }

      if (redirectsLeft <= 0) {
        throw new SafeFetchError("too_many_redirects", `Exceeded ${maxRedirects} redirects`);
      }

      const next = new URL(location, url);
      const dropBody = response.status === 303;
      const nextHeaders = new Headers(init.headers);

      if (next.origin !== url.origin) {
        for (const name of [
          "authorization",
          "cookie",
          "proxy-authorization",
          "x-api-key",
          "x-auth-token",
        ]) {
          nextHeaders.delete(name);
        }

        for (const name of [...nextHeaders.keys()]) {
          if (name.startsWith("x-bulletin-")) {
            nextHeaders.delete(name);
          }
        }
      }

      return execute(
        next,
        {
          ...(dropBody ? { ...init, method: "GET", body: null } : init),
          headers: nextHeaders,
        },
        redirectsLeft - 1,
      );
    }

    return response;
  };

  return async (input, init = {}) => {
    let url: URL;

    try {
      url = input instanceof URL ? input : new URL(input);
    } catch {
      throw new SafeFetchError("invalid_url", "Invalid URL");
    }

    return execute(url, init, maxRedirects);
  };
}

function envAllowlist(): readonly string[] {
  const value = Bun.env.SAFE_FETCH_DEV_ALLOW;
  return value === undefined
    ? []
    : value
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean);
}

export const safeFetch: SafeFetch = createSafeFetch({ devAllow: envAllowlist() });
