import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { Logger } from "@bulletin/config";

export type EgressDenyReason =
  | "host"
  | "address"
  | "scheme"
  | "port"
  | "credentials"
  | "method"
  | "header"
  | "request"
  | "redirect"
  | "response";

export class EgressDeniedError extends Error {
  readonly reason: EgressDenyReason;

  constructor(reason: EgressDenyReason, message: string) {
    super(message);
    this.name = "EgressDeniedError";
    this.reason = reason;
  }
}

export interface EgressRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface EgressResponse {
  readonly url: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface DnsAddress {
  readonly address: string;
  readonly family: number;
}

export type EgressLookup = (hostname: string) => Promise<readonly DnsAddress[]>;
export type EgressFetch = (
  url: string,
  init: RequestInit,
  addresses?: readonly DnsAddress[],
) => Promise<Response>;

export interface EgressOptions {
  /** Exact lowercase hostnames from the plugin manifest. */
  readonly allowedHosts: readonly string[];
  readonly logger: Logger;
  readonly lookup?: EgressLookup;
  readonly fetch?: EgressFetch;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_REQUEST_BYTES = 256 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "HEAD"]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MAX_HEADERS = 64;
const MAX_HEADER_NAME = 64;
const MAX_HEADER_VALUE = 1_024;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;

interface Ipv4Range {
  readonly base: readonly [number, number, number, number];
  readonly prefix: number;
}

const BLOCKED_IPV4: readonly Ipv4Range[] = [
  { base: [0, 0, 0, 0], prefix: 8 },
  { base: [10, 0, 0, 0], prefix: 8 },
  { base: [100, 64, 0, 0], prefix: 10 },
  { base: [127, 0, 0, 0], prefix: 8 },
  { base: [168, 63, 129, 16], prefix: 32 }, // Azure wire server / metadata
  { base: [169, 254, 0, 0], prefix: 16 },
  { base: [172, 16, 0, 0], prefix: 12 },
  { base: [192, 0, 0, 0], prefix: 24 },
  { base: [192, 0, 2, 0], prefix: 24 },
  { base: [192, 88, 99, 0], prefix: 24 },
  { base: [192, 168, 0, 0], prefix: 16 },
  { base: [198, 18, 0, 0], prefix: 15 },
  { base: [198, 51, 100, 0], prefix: 24 },
  { base: [203, 0, 113, 0], prefix: 24 },
  { base: [224, 0, 0, 0], prefix: 4 },
  { base: [240, 0, 0, 0], prefix: 4 },
];

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  let value = 0;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return undefined;
    }

    const octet = Number(part);

    if (octet < 0 || octet > 255) {
      return undefined;
    }

    value = (value << 8) | octet;
  }

  return value >>> 0;
}

function rangeToInt(range: Ipv4Range): number {
  return ipv4ToInt(range.base.join(".")) ?? 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);

  if (value === undefined) {
    return true;
  }

  for (const range of BLOCKED_IPV4) {
    const mask = range.prefix === 0 ? 0 : (0xffff_ffff << (32 - range.prefix)) >>> 0;

    if ((value & mask) === (rangeToInt(range) & mask)) {
      return true;
    }
  }

  return false;
}

function parseIpv6(address: string): Uint8Array | undefined {
  const withoutZone = address.split("%")[0] ?? "";
  const halves = withoutZone.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") {
      return [];
    }

    const groups: number[] = [];

    for (const group of part.split(":")) {
      if (group.includes(".")) {
        const ipv4 = ipv4ToInt(group);

        if (ipv4 === undefined) {
          return undefined;
        }

        groups.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(group)) {
        return undefined;
      }

      groups.push(Number.parseInt(group, 16));
    }

    return groups;
  };

  const left = parseGroups(halves[0] ?? "");

  if (left === undefined) {
    return undefined;
  }

  let groups: number[];

  if (halves.length === 1) {
    groups = left;
  } else {
    const right = parseGroups(halves[1] ?? "");

    if (right === undefined) {
      return undefined;
    }

    const missing = 8 - left.length - right.length;

    if (missing < 0) {
      return undefined;
    }

    groups = [...left, ...Array<number>(missing).fill(0), ...right];
  }

  if (groups.length !== 8) {
    return undefined;
  }

  const bytes = new Uint8Array(16);

  for (let index = 0; index < 8; index += 1) {
    const group = groups[index] ?? 0;
    bytes[index * 2] = group >>> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }

  return bytes;
}

function matchesPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  let remaining = bits;

  for (let index = 0; index < prefix.length && remaining > 0; index += 1) {
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;

    if (((bytes[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) {
      return false;
    }

    remaining -= 8;
  }

  return true;
}

function embeddedIpv4(bytes: Uint8Array): string {
  return [bytes[12], bytes[13], bytes[14], bytes[15]].map((value) => value ?? 0).join(".");
}

function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6(address);

  if (bytes === undefined) {
    return true;
  }

  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96) and NAT64 (64:ff9b::/96)
  // all carry an IPv4 address that must be checked separately.
  if (matchesPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) {
    return isBlockedIpv4(embeddedIpv4(bytes));
  }

  if (matchesPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return true;
  }

  if (matchesPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return isBlockedIpv4(embeddedIpv4(bytes));
  }

  return (
    matchesPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) || // documentation
    matchesPrefix(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0], 64) || // discard
    matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x02], 48) || // benchmarking
    matchesPrefix(bytes, [0xfc, 0x00], 7) || // unique local
    matchesPrefix(bytes, [0xfe, 0x80], 10) || // link local
    matchesPrefix(bytes, [0xfe, 0xc0], 10) || // deprecated site local
    matchesPrefix(bytes, [0xff, 0x00], 8) // multicast
  );
}

/** True for loopback, private, link-local, CGNAT, documentation, metadata and multicast. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    return isBlockedIpv4(address);
  }

  if (family === 6) {
    return isBlockedIpv6(address);
  }

  return true;
}

function normalizeHost(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, "");
}

function validateHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  const entries = Object.entries(headers);

  if (entries.length > MAX_HEADERS) {
    throw new EgressDeniedError("header", "Too many request headers");
  }

  const result: Record<string, string> = {};

  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();

    if (
      !HEADER_NAME.test(name) ||
      name.length > MAX_HEADER_NAME ||
      value.length > MAX_HEADER_VALUE ||
      value.includes("\r") ||
      value.includes("\n")
    ) {
      throw new EgressDeniedError("header", "Invalid request header");
    }

    if (BLOCKED_REQUEST_HEADERS.has(name) || name.startsWith("proxy-")) {
      continue;
    }

    result[name] = value;
  }

  return result;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new EgressDeniedError("response", "Response body is too large");
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

function responseHeaders(response: Response): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  let total = 0;

  for (const [name, value] of response.headers.entries()) {
    const lower = name.toLowerCase();

    if (lower === "set-cookie" || lower === "cookie" || lower === "authorization") {
      continue;
    }

    total += name.length + value.length;

    if (total > MAX_RESPONSE_HEADER_BYTES) {
      throw new EgressDeniedError("response", "Response headers are too large");
    }

    headers[lower] = value;
  }

  return headers;
}

function defaultLookup(hostname: string): Promise<readonly DnsAddress[]> {
  return import("node:dns/promises").then(({ lookup }) =>
    lookup(hostname, { all: true, verbatim: true }),
  );
}

/**
 * Fetches the already-validated address rather than letting the runtime resolve the name a
 * second time. The TLS SNI and Host header stay the manifest host, so certificate
 * verification is unchanged; only the connection destination is pinned.
 */
async function pinnedFetch(
  url: string,
  init: RequestInit,
  addresses?: readonly DnsAddress[],
): Promise<Response> {
  if (addresses === undefined || addresses.length === 0) {
    return globalThis.fetch(url, init);
  }

  const target = new URL(url);
  const address = addresses[0]?.address;
  const family = addresses[0]?.family;

  if (address === undefined) {
    throw new Error("No validated address");
  }

  const secure = target.protocol === "https:";
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const connectHost = family === 6 ? `[${address}]` : address;
  const options = {
    hostname: connectHost,
    port: target.port === "" ? (secure ? 443 : 80) : Number(target.port),
    path: `${target.pathname}${target.search}`,
    method: init.method ?? "GET",
    headers: {
      ...(init.headers as Record<string, string>),
      host: target.host,
    },
    ...(secure ? { servername: hostname } : {}),
  };

  return new Promise<Response>((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)(options, (response) => {
      const headers = new Headers();

      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }

      resolve(
        new Response(Readable.toWeb(response) as ReadableStream, {
          status: response.statusCode ?? 502,
          headers,
        }),
      );
    });
    request.on("error", reject);
    init.signal?.addEventListener("abort", () => request.destroy(new Error("Request aborted")));
    if (typeof init.body === "string") {
      request.write(init.body);
    }
    request.end();
  });
}

/**
 * The broker's egress proxy. Every URL (including every redirect hop) must pass the
 * manifest allowlist, scheme/port checks and a DNS check that rejects loopback, private,
 * link-local, metadata and other non-public addresses.
 */
export class EgressProxy {
  readonly #allowedHosts: ReadonlySet<string>;
  readonly #logger: Logger;
  readonly #lookup: EgressLookup;
  readonly #fetch: EgressFetch;
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  constructor(options: EgressOptions) {
    this.#allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.#logger = options.logger;
    this.#lookup = options.lookup ?? defaultLookup;
    this.#fetch = options.fetch ?? pinnedFetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async request(input: EgressRequest): Promise<EgressResponse> {
    const method = (input.method ?? "GET").toUpperCase();

    if (!ALLOWED_METHODS.has(method)) {
      throw new EgressDeniedError("method", "Only GET, POST and HEAD are allowed");
    }

    if (input.body !== undefined && (method === "GET" || method === "HEAD")) {
      throw new EgressDeniedError("request", `${method} requests cannot have a body`);
    }

    if (
      input.body !== undefined &&
      new TextEncoder().encode(input.body).byteLength > this.#maxRequestBytes
    ) {
      throw new EgressDeniedError("request", "Request body is too large");
    }

    const headers = validateHeaders(input.headers);
    let url = input.url;
    let currentMethod = method;
    let body = input.body;

    for (let hop = 0; ; hop += 1) {
      const target = await this.#validate(url);

      let response: Response;

      try {
        response = await this.#fetch(
          target.url.toString(),
          {
            method: currentMethod,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: "manual",
            credentials: "omit",
            signal: AbortSignal.timeout(this.#timeoutMs),
          },
          target.addresses,
        );
      } catch (error) {
        this.#logger.warn("egress.request_failed", { host: target.url.hostname });
        throw new EgressDeniedError(
          "request",
          error instanceof Error ? "Request failed" : String(error),
        );
      }

      const location = response.headers.get("location");

      if (response.status >= 300 && response.status < 400 && location !== null) {
        if (hop >= this.#maxRedirects) {
          throw new EgressDeniedError("redirect", "Too many redirects");
        }

        let next: URL;

        try {
          next = new URL(location, target.url);
        } catch {
          throw new EgressDeniedError("redirect", "Redirect target is not a valid URL");
        }

        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && currentMethod === "POST")
        ) {
          currentMethod = "GET";
          body = undefined;
        }

        url = next.toString();
        continue;
      }

      return {
        url: target.url.toString(),
        status: response.status,
        headers: responseHeaders(response),
        body: await readBodyCapped(response, this.#maxResponseBytes),
      };
    }
  }

  async #validate(input: string): Promise<{ url: URL; addresses: readonly DnsAddress[] }> {
    let url: URL;

    try {
      url = new URL(input);
    } catch {
      throw new EgressDeniedError("host", "URL is not valid");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new EgressDeniedError("scheme", "Only http and https URLs are allowed");
    }

    if (url.username !== "" || url.password !== "") {
      throw new EgressDeniedError("credentials", "URL credentials are not allowed");
    }

    const host = normalizeHost(url.hostname);

    if (host === "") {
      throw new EgressDeniedError("host", "URL has no host");
    }

    if (isIP(host) !== 0) {
      throw new EgressDeniedError("address", "IP address literals are not allowed");
    }

    if (url.port !== "" && url.port !== "80" && url.port !== "443") {
      throw new EgressDeniedError("port", "Only ports 80 and 443 are allowed");
    }

    if (!this.#allowedHosts.has(host)) {
      this.#logger.warn("egress.host_denied", { host });
      throw new EgressDeniedError("host", "Host is not on the plugin's egress allowlist");
    }

    let addresses: readonly DnsAddress[];

    try {
      addresses = await this.#lookup(host);
    } catch {
      throw new EgressDeniedError("address", "Host could not be resolved");
    }

    if (addresses.length === 0) {
      throw new EgressDeniedError("address", "Host could not be resolved");
    }

    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      this.#logger.warn("egress.address_denied", { host });
      throw new EgressDeniedError(
        "address",
        "Host resolves to a private, loopback, link-local or metadata address",
      );
    }

    return { url, addresses };
  }
}
