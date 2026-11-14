import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isBlockedAddress } from "../net/address.ts";
import { checkOutboundScheme, type OutboundNodeEnv, type Resolver } from "../net/safe-fetch.ts";

export type PushEndpointErrorCode =
  | "invalid_url"
  | "https_required"
  | "credentials"
  | "unusual_port"
  | "dns_error"
  | "blocked_address";

export interface PushEndpointValidation {
  readonly ok: boolean;
  readonly url?: URL;
  readonly code?: PushEndpointErrorCode;
}

export interface PushEndpointOptions {
  readonly nodeEnv?: OutboundNodeEnv;
  readonly devAllow?: readonly string[];
  readonly resolve?: Resolver;
}

const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family }));
};

function invalid(code: PushEndpointErrorCode): PushEndpointValidation {
  return { ok: false, code };
}

/**
 * Validates a client-supplied push endpoint before it is stored (ADR 0016, ADR 0014):
 * same-origin rules as every outbound request, no credentials, a public address and (unless a
 * development mock is explicitly allowlisted) the HTTPS port. Sending repeats the address
 * checks through `safeFetch`, which also pins DNS so a rebinding answer cannot take effect.
 */
export async function validatePushEndpoint(
  value: string,
  options: PushEndpointOptions = {},
): Promise<PushEndpointValidation> {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return invalid("invalid_url");
  }

  const nodeEnv =
    options.nodeEnv ??
    ((Bun.env.NODE_ENV === "production" ? "production" : "development") as OutboundNodeEnv);
  const scheme = checkOutboundScheme(url.protocol, nodeEnv);

  if (!scheme.allowed) {
    return invalid(scheme.code);
  }

  if (url.username !== "" || url.password !== "") {
    return invalid("credentials");
  }

  if (url.hash !== "" || url.hostname === "") {
    return invalid("invalid_url");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const devAllow = new Set(
    (options.devAllow ?? []).map((host) => host.trim().toLowerCase()).filter((host) => host !== ""),
  );
  const allowlisted = devAllow.has(hostname) || devAllow.has(url.host.toLowerCase());

  if (!allowlisted && url.port !== "" && url.port !== "443") {
    return invalid("unusual_port");
  }

  let addresses: readonly { readonly address: string; readonly family: number }[];

  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await (options.resolve ?? defaultResolver)(hostname);
    } catch {
      return invalid("dns_error");
    }
  }

  if (addresses.length === 0) {
    return invalid("dns_error");
  }

  if (!allowlisted) {
    for (const address of addresses) {
      if (isBlockedAddress(address.address)) {
        return invalid("blocked_address");
      }
    }
  }

  return { ok: true, url };
}
