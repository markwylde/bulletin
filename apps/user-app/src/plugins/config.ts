import { parsePluginOrigin } from "@bulletin/plugin-sdk/origin";

/**
 * The configured plugin frame origin (ADR 0018). Local development uses the compose proxy
 * hostname; a deployment sets `BULLETIN_PLUGINS_ORIGIN` to its separate-domain https origin.
 * An invalid value is ignored, so a frame can never be pointed at an untrusted scheme.
 */
export function configuredPluginOrigin(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  return (
    parsePluginOrigin(env.BULLETIN_PLUGINS_ORIGIN) ??
    `http://plugins.bulletin.localhost:${env.BULLETIN_HTTP_PORT ?? "8080"}`
  );
}
