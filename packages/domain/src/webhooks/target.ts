import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  checkOutboundScheme,
  isBlockedAddress,
  type OutboundNodeEnv,
  safeFetchDevAllowlist,
} from "../net/index.ts";

export type WebhookTargetError = "invalid_url" | "https_required" | "blocked_address" | "dns_error";

export type WebhookTargetResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: WebhookTargetError };

export interface WebhookTargetOptions {
  readonly nodeEnv: OutboundNodeEnv;
  /** Explicit local mock hosts allowed to resolve privately (ADR 0016). */
  readonly devAllow?: readonly string[];
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
}

/**
 * Validates a webhook URL at configuration time (ADR 0016). Delivery still re-resolves and
 * pins the address in `safeFetch`; this check only stops an admin saving a target that can
 * never be reached safely in production.
 */
export async function validateWebhookTarget(
  value: string,
  options: WebhookTargetOptions,
): Promise<WebhookTargetResult> {
  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, code: "invalid_url" };
  }

  if (url.hostname === "") {
    return { ok: false, code: "invalid_url" };
  }

  const scheme = checkOutboundScheme(url.protocol, options.nodeEnv);

  if (!scheme.allowed) {
    return { ok: false, code: scheme.code };
  }

  const allow = new Set(
    (options.devAllow ?? safeFetchDevAllowlist())
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );

  if (options.nodeEnv === "production" && allow.size > 0) {
    return { ok: false, code: "blocked_address" };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (allow.has(hostname) || allow.has(url.host.toLowerCase())) {
    return { ok: true, url: url.toString() };
  }

  const literal = isIP(hostname);
  let addresses: readonly string[];

  if (literal !== 0) {
    addresses = [hostname];
  } else {
    try {
      const records = options.resolve
        ? await options.resolve(hostname)
        : (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address);
      addresses = records;
    } catch {
      return { ok: false, code: "dns_error" };
    }
  }

  if (addresses.length === 0) {
    return { ok: false, code: "dns_error" };
  }

  if (addresses.some((address) => isBlockedAddress(address))) {
    return { ok: false, code: "blocked_address" };
  }

  return { ok: true, url: url.toString() };
}
