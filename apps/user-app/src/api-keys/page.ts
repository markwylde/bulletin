import type { Translator } from "@bulletin/i18n";

export interface ApiKeyLabels {
  readonly prefix: string;
  readonly scopes: string;
  readonly created: string;
  readonly lastUsed: string;
  readonly expires: string;
  readonly revoked: string;
  readonly revoke: string;
  readonly revoking: string;
  readonly empty: string;
  readonly loadError: string;
  readonly createFailed: string;
  readonly revokeFailed: string;
  readonly createdMessage: string;
  readonly revokedMessage: string;
  readonly invalid: string;
}

export function apiKeyLabels(translate: Translator): ApiKeyLabels {
  return {
    prefix: translate("apiKeys.prefix"),
    scopes: translate("apiKeys.scopes"),
    created: translate("apiKeys.created"),
    lastUsed: translate("apiKeys.lastUsed"),
    expires: translate("apiKeys.expires"),
    revoked: translate("apiKeys.revoked"),
    revoke: translate("apiKeys.revoke"),
    revoking: translate("apiKeys.revoking"),
    empty: translate("apiKeys.empty"),
    loadError: translate("apiKeys.loadError"),
    createFailed: translate("apiKeys.createFailed"),
    revokeFailed: translate("apiKeys.revokeFailed"),
    createdMessage: translate("apiKeys.createdMessage"),
    revokedMessage: translate("apiKeys.revokedMessage"),
    invalid: translate("apiKeys.invalid"),
  };
}

const SCOPE_LABELS = {
  "read:forums": { labelKey: "apiKeys.scope.readForums" },
  "read:topics": { labelKey: "apiKeys.scope.readTopics" },
  "read:posts": { labelKey: "apiKeys.scope.readPosts" },
  "read:members": { labelKey: "apiKeys.scope.readMembers" },
  "read:search": { labelKey: "apiKeys.scope.readSearch" },
  "write:posts": { labelKey: "apiKeys.scope.writePosts" },
  "write:reactions": { labelKey: "apiKeys.scope.writeReactions" },
  "write:follows": { labelKey: "apiKeys.scope.writeFollows" },
} as const;

export function apiKeyScopeLabels(translate: Translator): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SCOPE_LABELS).map(([scope, { labelKey }]) => [scope, translate(labelKey)]),
  );
}
