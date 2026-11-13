/**
 * Plugin frame origin policy (ADR 0018).
 *
 * Plugin client apps are framed from a separate origin so they share no cookies and no
 * same-site status with the forum. Production serves them over https on a different
 * registrable domain; plain http is only accepted for loopback hosts in local development.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  return LOOPBACK_HOSTS.has(lower) || lower.endsWith(".localhost");
}

/**
 * Parses an exact origin: scheme, host and optional port only, with no credentials, path,
 * query or fragment. Returns undefined for anything else, so a bad value fails closed.
 */
export function parsePluginOrigin(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }

  if (url.username !== "" || url.password !== "") {
    return undefined;
  }

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return undefined;
  }

  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return undefined;
  }

  return url.origin;
}

/**
 * The conventional plugin origin for a forum page: the same scheme and port on a
 * `plugins.<forum-host>` hostname. Only used when no host-configured origin is present.
 */
export function conventionalPluginOrigin(currentHref: string): string {
  const fallback = new URL(currentHref);

  if (!fallback.hostname.startsWith("plugins.")) {
    fallback.hostname = `plugins.${fallback.hostname}`;
  }

  fallback.pathname = "";
  fallback.search = "";
  fallback.hash = "";
  return fallback.origin;
}
