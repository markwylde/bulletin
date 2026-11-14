import { isValidFlagDefinition } from "./rules.ts";
import type { FlagDefinition } from "./types.ts";

export interface FlagDeclaration {
  readonly key: string;
  readonly description: string;
  /** The team or person responsible for removing the flag once it is stable. */
  readonly owner: string;
  /** Environment default from code, before any staff rule. */
  readonly default: boolean;
  readonly affectsRender?: boolean;
  readonly clientVisible?: boolean;
}

/**
 * Declares a flag in code. `syncFlagDefinitions` upserts missing declarations at startup, so a
 * new flag appears in the staff app with its code default and no rules.
 */
export function defineFlag(declaration: FlagDeclaration): FlagDefinition {
  const definition: FlagDefinition = {
    key: declaration.key,
    description: declaration.description,
    owner: declaration.owner,
    defaultValue: declaration.default,
    affectsRender: declaration.affectsRender ?? false,
    clientVisible: declaration.clientVisible ?? false,
    rules: Object.freeze([]),
  };

  if (!isValidFlagDefinition(definition)) {
    throw new Error(
      `Invalid flag declaration "${declaration.key}": key, description and owner are required`,
    );
  }

  return Object.freeze(definition);
}

/** Validates a registry, rejecting duplicate keys before anything reaches the database. */
export function assertFlagDefinitions(definitions: readonly FlagDefinition[]): void {
  const seen = new Set<string>();

  for (const definition of definitions) {
    if (!isValidFlagDefinition(definition)) {
      throw new Error(`Invalid flag definition "${definition.key}"`);
    }

    if (seen.has(definition.key)) {
      throw new Error(`Duplicate flag definition "${definition.key}"`);
    }

    seen.add(definition.key);
  }
}

/** Global and forum announcements (ADR 0010, change `forum-structure`). */
export const announcementsFlag = defineFlag({
  key: "announcements",
  description: "Global and forum announcements.",
  owner: "core",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Link preview cards fetched by the unfurl worker (ADR 0007). */
export const unfurlsFlag = defineFlag({
  key: "unfurls",
  description: "Link preview cards fetched by workers.",
  owner: "content",
  default: false,
  affectsRender: true,
});

/** @mentions and the editor autocomplete (ADR 0007). */
export const mentionsFlag = defineFlag({
  key: "mentions",
  description: "Member mentions and editor autocomplete.",
  owner: "content",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Topic polls and the poll editor (change `topics-posts`). */
export const pollsFlag = defineFlag({
  key: "polls",
  description: "Topic polls, voting and poll results.",
  owner: "topics",
  default: false,
  affectsRender: true,
  clientVisible: false,
});

/** Post and message attachments, the editor upload controls and delivery routes (ADR 0019). */
export const attachmentsFlag = defineFlag({
  key: "attachments",
  description: "Post attachments, uploads and the editor attachment controls.",
  owner: "attachments",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Member avatar uploads and removal; public avatar display is always available (ADR 0019). */
export const avatarUploadFlag = defineFlag({
  key: "avatar_upload",
  description: "Member avatar upload, crop and removal.",
  owner: "attachments",
  default: false,
  affectsRender: false,
  clientVisible: true,
});

/** In-app notifications and the notification centre (change `events-notifications`). */
export const notificationsFlag = defineFlag({
  key: "notifications",
  description: "In-app notifications, the bell and the notification centre.",
  owner: "events",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Topic, forum and member follows (change `events-notifications`). */
export const followsFlag = defineFlag({
  key: "follows",
  description: "Following topics, forums and members.",
  owner: "events",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Daily and weekly email digests (change `events-notifications`). */
export const digestsFlag = defineFlag({
  key: "digests",
  description: "Daily and weekly email digests.",
  owner: "events",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** The SSE stream, live counts and the new-replies banner (change `events-notifications`). */
export const realtimeFlag = defineFlag({
  key: "realtime",
  description: "Live counts, new-reply banners and stream session handling.",
  owner: "events",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Private multi-participant conversations (change `conversations`). */
export const conversationsFlag = defineFlag({
  key: "conversations",
  description: "Private multi-participant conversations, their inbox and live replies.",
  owner: "conversations",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Post reactions, the reaction bar and the who-reacted list (change `reactions-reputation`). */
export const reactionsFlag = defineFlag({
  key: "reactions",
  description: "Post reactions, reaction totals and the who-reacted list.",
  owner: "reactions",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Member reputation, giving feedback and the label scale (change `reactions-reputation`). */
export const reputationFlag = defineFlag({
  key: "reputation",
  description: "Member reputation totals, labels and giving feedback on posts.",
  owner: "reactions",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Member profiles and their fields, signatures and privacy options (change `member-profiles`). */
export const customProfileFieldsFlag = defineFlag({
  key: "custom_profile_fields",
  description: "Staff-defined custom profile fields and their values.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

export const signaturesFlag = defineFlag({
  key: "signatures",
  description: "Member signatures under posts and the signature editor.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

export const friendsFlag = defineFlag({
  key: "friends",
  description: "Friend requests, friend lists and friend notifications.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

export const ignoreListFlag = defineFlag({
  key: "ignore_list",
  description: "Ignoring members, collapsed posts and ignore filtering.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

export const memberDirectoryFlag = defineFlag({
  key: "member_directory",
  description: "The member list with search, filters and sorting.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: false,
});

export const whosOnlineFlag = defineFlag({
  key: "whos_online",
  description: "The who's-online summary and full online list.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: false,
});

export const leaderboardsFlag = defineFlag({
  key: "leaderboards",
  description: "Top-poster and most-reacted leaderboards and today's top poster.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: false,
});

export const badgesFlag = defineFlag({
  key: "badges",
  description: "Member badges, awards and featured badges.",
  owner: "members",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Warning points, thresholds, acknowledgements and member warning history (change `moderation`). */
export const warningsFlag = defineFlag({
  key: "warnings",
  description: "Member warnings, warning history and acknowledgement gates.",
  owner: "moderation",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Full-text search, the quick-search box and the member activity views (change `search`). */
export const searchFlag = defineFlag({
  key: "search",
  description: "Full-text search, the quick-search box and member activity views.",
  owner: "search",
  default: false,
  affectsRender: true,
  clientVisible: false,
});

/** RSS and Atom feeds for the board and each readable forum (change `seo-feeds`). */
export const feedsFlag = defineFlag({
  key: "feeds",
  description: "RSS and Atom feeds for the board and each readable forum.",
  owner: "seo",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Member and guest theme/scheme chooser (change `themes`). */
export const themeChooserFlag = defineFlag({
  key: "theme_chooser",
  description: "The footer and settings theme and colour-scheme chooser.",
  owner: "themes",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Saved multi-moderation actions applied by moderators (change `moderation`). */
export const multimodFlag = defineFlag({
  key: "multimod",
  description: "Saved multi-moderation actions and one-click application.",
  owner: "moderation",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Marketplace installs, plugin hooks, routes and client apps (change `plugin-platform`). */
export const pluginsFlag = defineFlag({
  key: "plugins",
  description: "Runtime-installed plugins, marketplace installs, hooks and client apps.",
  owner: "plugins",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** The versioned public API, its docs page and personal/integration keys (change `public-api-webhooks`). */
export const publicApiFlag = defineFlag({
  key: "public_api",
  description: "The /api/v1 public API, its documentation and key management.",
  owner: "platform",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Outbound webhook configuration and deliveries (change `public-api-webhooks`). */
export const webhooksFlag = defineFlag({
  key: "webhooks",
  description: "Outbound webhook configuration and deliveries.",
  owner: "platform",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Installable PWA: manifest, icons, service worker and the offline shell (ADR 0014). */
export const pwaFlag = defineFlag({
  key: "pwa",
  description: "The installable PWA, its manifest, service worker and offline shell.",
  owner: "platform",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Web Push subscriptions, device management and the push settings UI (ADR 0014). */
export const webPushFlag = defineFlag({
  key: "web_push",
  description: "Web Push notifications, registered devices and push preferences.",
  owner: "events",
  default: false,
  affectsRender: true,
  clientVisible: true,
});

/** Every flag declared in code. Each feature adds its own entry here. */
export const CODE_FLAG_DEFINITIONS: readonly FlagDefinition[] = Object.freeze([
  announcementsFlag,
  unfurlsFlag,
  mentionsFlag,
  pollsFlag,
  attachmentsFlag,
  avatarUploadFlag,
  notificationsFlag,
  followsFlag,
  digestsFlag,
  realtimeFlag,
  conversationsFlag,
  reactionsFlag,
  reputationFlag,
  customProfileFieldsFlag,
  signaturesFlag,
  friendsFlag,
  ignoreListFlag,
  memberDirectoryFlag,
  whosOnlineFlag,
  leaderboardsFlag,
  badgesFlag,
  warningsFlag,
  multimodFlag,
  searchFlag,
  feedsFlag,
  themeChooserFlag,
  pluginsFlag,
  publicApiFlag,
  webhooksFlag,
  pwaFlag,
  webPushFlag,
]);
