import { createHmac } from "node:crypto";

/**
 * Forwards SDK core-data calls from a sandbox to the core APIs (ADR 0009).
 *
 * The plugin never chooses who it is acting for: the broker attaches the trusted viewer
 * context from the request that triggered the hook (guest when there is none). The core API
 * then applies `can()` for that viewer, so a privileged viewer can never hand a plugin data
 * its service principal could not read.
 */

export interface ViewerContext {
  readonly memberId: string | null;
  readonly sessionId?: string | null;
}

export const GUEST_VIEWER: ViewerContext = { memberId: null };

export interface CoreCall {
  readonly pluginId: string;
  readonly method: string;
  readonly params: unknown;
  readonly viewer: ViewerContext;
}

export type CoreDenyReason = "method" | "request" | "response" | "size";

/** The broker-facing subset, so tests and future transports can provide it. */
export interface CoreForwarder {
  call(call: CoreCall): Promise<unknown>;
}

export class CoreDeniedError extends Error {
  readonly reason: CoreDenyReason;

  constructor(reason: CoreDenyReason, message: string) {
    super(message);
    this.name = "CoreDeniedError";
    this.reason = reason;
  }
}

export type CoreFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CoreApiOptions {
  /** Base URL of the core API, e.g. `http://user-api:3001`. */
  readonly baseUrl: string;
  /** Shared broker secret; the request body is also HMAC-signed with it. */
  readonly token: string;
  readonly fetch?: CoreFetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Methods the broker may forward. The SDK adds to this list, never a plugin. */
  readonly allowedMethods?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const CORE_PATH = "/internal/plugins/core";
const METHOD_PATTERN = /^[a-z][a-z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/;

/** SDK core APIs available to plugins. Anything else is a broker configuration error. */
export const DEFAULT_CORE_METHODS: readonly string[] = [
  "forums.get",
  "forums.list",
  "members.addBadge",
  "members.get",
  "posts.get",
  "topics.get",
];

/** The capability each core API method needs. Unknown methods have no scope, so are denied. */
export { CORE_METHOD_SCOPES, coreMethodScope } from "@bulletin/plugin-sdk/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactViewer(viewer: ViewerContext): ViewerContext {
  return viewer.sessionId === undefined || viewer.sessionId === null
    ? { memberId: viewer.memberId }
    : { memberId: viewer.memberId, sessionId: viewer.sessionId };
}

export class CoreApiClient implements CoreForwarder {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #fetch: CoreFetch;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #allowedMethods: ReadonlySet<string>;

  constructor(options: CoreApiOptions) {
    let base: URL;

    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new TypeError("Core API base URL is not valid");
    }

    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new TypeError("Core API base URL must use http or https");
    }

    this.#baseUrl = base.toString().replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#allowedMethods = new Set(options.allowedMethods ?? DEFAULT_CORE_METHODS);
  }

  async call(call: CoreCall): Promise<unknown> {
    if (!METHOD_PATTERN.test(call.method) || !this.#allowedMethods.has(call.method)) {
      throw new CoreDeniedError("method", `Core API method ${call.method} is not allowed`);
    }

    const body = JSON.stringify({
      pluginId: call.pluginId,
      method: call.method,
      params: call.params ?? null,
      viewer: compactViewer(call.viewer),
    });
    const timestamp = Date.now().toString();
    const signature = createHmac("sha256", this.#token)
      .update(`${call.pluginId}\n${timestamp}\n${body}`)
      .digest("hex");

    let response: Response;

    try {
      response = await this.#fetch(`${this.#baseUrl}${CORE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-plugin": call.pluginId,
          "x-bulletin-timestamp": timestamp,
          "x-bulletin-signature": signature,
          authorization: `Bearer ${this.#token}`,
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new CoreDeniedError("request", "Core API request failed");
    }

    const text = await response.text();

    if (text.length > this.#maxResponseBytes) {
      throw new CoreDeniedError("size", "Core API response is too large");
    }

    if (!response.ok) {
      throw new CoreDeniedError(
        "response",
        response.status === 403
          ? "Core API denied the request for this viewer"
          : "Core API request failed",
      );
    }

    if (text === "") {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) && "result" in parsed ? parsed.result : parsed;
    } catch {
      throw new CoreDeniedError("response", "Core API returned invalid JSON");
    }
  }
}
