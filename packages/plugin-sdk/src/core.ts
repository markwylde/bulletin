/**
 * SDK core APIs and the capability each one needs (ADR 0009).
 *
 * Both the broker (before forwarding) and the core endpoint (before answering) check the
 * method's capability against the admin-approved grants, so a plugin can never widen its
 * access by editing its bundle.
 */

export type CoreCapability = "core.read" | "core.write";

/** The capability each core API method needs. Unknown methods have no scope, so are denied. */
export const CORE_METHOD_SCOPES: Readonly<Record<string, CoreCapability>> = {
  "forums.get": "core.read",
  "forums.list": "core.read",
  "members.addBadge": "core.write",
  "members.get": "core.read",
  "posts.get": "core.read",
  "topics.get": "core.read",
};

export function coreMethodScope(method: string): CoreCapability | undefined {
  return CORE_METHOD_SCOPES[method];
}
