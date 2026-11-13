import type { SQL } from "bun";
import { can, type PermissionAction, type PermissionScope } from "../permissions/can.ts";
import { GUEST_PRINCIPAL } from "../permissions/principal.ts";
import { type ApiPrincipal, isApiKeyPrincipal } from "./principal.ts";

/**
 * Runs a permission check for an API principal. Guest requests go through the same guest
 * group path as the public apps; key requests use the key's principal member. There is no
 * second authorisation implementation for the API (ADR 0005, 0016).
 */
export function apiCan(
  sql: SQL,
  principal: ApiPrincipal,
  action: PermissionAction,
  scope?: PermissionScope,
): Promise<boolean> {
  return isApiKeyPrincipal(principal)
    ? can(sql, principal.memberId, action, scope)
    : can(sql, GUEST_PRINCIPAL, action, scope);
}
