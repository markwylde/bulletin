import { DEFAULT_LOCALE, isLocale, type Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import {
  ATTACHMENT_CONTENT_TYPES,
  type AttachmentContentType,
  isAttachmentContentType,
} from "../attachments/rules.ts";
import {
  DEFAULT_REPUTATION_LABEL_SCALE,
  isReputationLabelKey,
  REPUTATION_LABEL_KEYS,
  type ReputationLabel,
} from "../reputation/labels.ts";

export const DEFAULT_ATTACHMENT_TYPES: readonly AttachmentContentType[] = ATTACHMENT_CONTENT_TYPES;

export interface BoardSettings {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: Locale;
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly topicsPerPage: number;
  readonly postsPerPage: number;
  readonly publicEditHistory: boolean;
  /** Hold a new member's first N approved posts and topics; zero is off. */
  readonly newMemberApprovalPosts: number;
  /** How long post and login IP records are kept (ADR 0012). */
  readonly ipRetentionDays: number;
  readonly attachmentAllowedTypes: readonly AttachmentContentType[];
  /** Reactions with a non-zero weight add reputation entries (reputation spec). */
  readonly reactionsAffectReputation: boolean;
  /** The board-wide switch for showing reputation totals and labels. */
  readonly reputationDisplay: boolean;
  readonly reputationLabelScale: readonly ReputationLabel[];
  /** Requests per minute allowed for one `/api/v1` key (ADR 0016). */
  readonly apiKeyRateLimitPerMinute: number;
  /** Requests per minute allowed from one client IP (ADR 0016). */
  readonly apiIpRateLimitPerMinute: number;
}

export interface BoardSettingsInput {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: Locale;
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly topicsPerPage: number;
  readonly postsPerPage: number;
  readonly publicEditHistory: boolean;
  /** Hold a new member's first N approved posts and topics; zero is off. */
  readonly newMemberApprovalPosts: number;
  /** How long post and login IP records are kept (ADR 0012). */
  readonly ipRetentionDays: number;
  readonly attachmentAllowedTypes: readonly AttachmentContentType[];
  readonly reactionsAffectReputation: boolean;
  readonly reputationDisplay: boolean;
  readonly reputationLabelScale: readonly ReputationLabel[];
  readonly apiKeyRateLimitPerMinute: number;
  readonly apiIpRateLimitPerMinute: number;
}

export const EMPTY_BOARD_SETTINGS: BoardSettings = {
  boardName: "",
  boardDescription: "",
  defaultLocale: DEFAULT_LOCALE,
  offline: false,
  offlineMessage: "",
  topicsPerPage: 20,
  postsPerPage: 20,
  publicEditHistory: false,
  newMemberApprovalPosts: 0,
  ipRetentionDays: 90,
  attachmentAllowedTypes: DEFAULT_ATTACHMENT_TYPES,
  reactionsAffectReputation: false,
  reputationDisplay: true,
  reputationLabelScale: DEFAULT_REPUTATION_LABEL_SCALE,
  apiKeyRateLimitPerMinute: 60,
  apiIpRateLimitPerMinute: 120,
};

export async function readBoardSettings(sql: SQL): Promise<BoardSettings> {
  const rows = (await sql`
    SELECT board_name, board_description, default_locale, offline, offline_message,
      topics_per_page, posts_per_page, public_edit_history, new_member_approval_posts,
      ip_retention_days, attachment_allowed_types, reactions_affect_reputation, reputation_display,
      reputation_label_scale, api_key_rate_limit_per_minute, api_ip_rate_limit_per_minute
    FROM core.board_settings
    WHERE id = 1
  `) as Array<{
    board_name: string;
    board_description: string;
    default_locale: string;
    offline: boolean;
    offline_message: string;
    topics_per_page: number;
    posts_per_page: number;
    public_edit_history: boolean;
    new_member_approval_posts: number;
    ip_retention_days: number;
    attachment_allowed_types: string[] | null;
    reactions_affect_reputation: boolean;
    reputation_display: boolean;
    reputation_label_scale: unknown;
    api_key_rate_limit_per_minute: number;
    api_ip_rate_limit_per_minute: number;
  }>;
  const row = rows[0];

  return {
    boardName: row?.board_name ?? "",
    boardDescription: row?.board_description ?? "",
    defaultLocale: isLocale(row?.default_locale) ? row.default_locale : DEFAULT_LOCALE,
    offline: row?.offline ?? false,
    offlineMessage: row?.offline_message ?? "",
    topicsPerPage: row?.topics_per_page ?? 20,
    postsPerPage: row?.posts_per_page ?? 20,
    publicEditHistory: row?.public_edit_history ?? false,
    newMemberApprovalPosts: row?.new_member_approval_posts ?? 0,
    ipRetentionDays: row?.ip_retention_days ?? 90,
    attachmentAllowedTypes:
      row?.attachment_allowed_types === null || row?.attachment_allowed_types === undefined
        ? DEFAULT_ATTACHMENT_TYPES
        : canonicalAttachmentTypes(row.attachment_allowed_types),
    reactionsAffectReputation: row?.reactions_affect_reputation ?? false,
    reputationDisplay: row?.reputation_display ?? true,
    reputationLabelScale: canonicalReputationLabelScale(row?.reputation_label_scale),
    apiKeyRateLimitPerMinute: row?.api_key_rate_limit_per_minute ?? 60,
    apiIpRateLimitPerMinute: row?.api_ip_rate_limit_per_minute ?? 120,
  };
}

/** Keeps known labels, valid thresholds, sorted ascending; unknown shapes use the defaults. */
export function canonicalReputationLabelScale(value: unknown): readonly ReputationLabel[] {
  let parsed = value;

  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return DEFAULT_REPUTATION_LABEL_SCALE;
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return DEFAULT_REPUTATION_LABEL_SCALE;
  }

  const labels: ReputationLabel[] = [];

  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const record = entry as { readonly min?: unknown; readonly labelKey?: unknown };

    if (
      typeof record.min !== "number" ||
      !Number.isInteger(record.min) ||
      typeof record.labelKey !== "string" ||
      !isReputationLabelKey(record.labelKey)
    ) {
      continue;
    }

    labels.push({ min: record.min, labelKey: record.labelKey });
  }

  if (labels.length === 0) {
    return DEFAULT_REPUTATION_LABEL_SCALE;
  }

  return labels.sort((left, right) => left.min - right.min);
}

/** Keeps only known content types, deduped and in the canonical allowlist order. */
export function canonicalAttachmentTypes(
  values: readonly string[],
): readonly AttachmentContentType[] {
  const allowed = new Set(values.filter(isAttachmentContentType));
  return ATTACHMENT_CONTENT_TYPES.filter((type) => allowed.has(type));
}

export type BoardSettingsParseResult =
  | { readonly ok: true; readonly value: BoardSettingsInput }
  | { readonly ok: false; readonly fields: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pageSize(value: unknown): number | null {
  if (value === undefined) {
    return 20;
  }

  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : null;
}

/** Validates a staff board-settings request body. Field ids match the form definition. */
export function parseBoardSettingsInput(value: unknown): BoardSettingsParseResult {
  if (!isRecord(value)) {
    return { ok: false, fields: ["form"] };
  }

  const fields: string[] = [];
  const boardName = typeof value.boardName === "string" ? value.boardName.trim() : "";
  const boardDescription = typeof value.boardDescription === "string" ? value.boardDescription : "";
  const offline = value.offline === true;
  const offlineMessage = typeof value.offlineMessage === "string" ? value.offlineMessage : "";
  const rawLocale = typeof value.defaultLocale === "string" ? value.defaultLocale : null;
  const defaultLocale: Locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;

  if (boardName.length === 0 || boardName.length > 100) {
    fields.push("boardName");
  }

  if (boardDescription.length > 5_000) {
    fields.push("boardDescription");
  }

  if (offline && offlineMessage.trim().length === 0) {
    fields.push("offlineMessage");
  }

  if (offlineMessage.length > 5_000) {
    fields.push("offlineMessage");
  }

  const topicsPerPage = pageSize(value.topicsPerPage);
  const postsPerPage = pageSize(value.postsPerPage);
  const publicEditHistory = value.publicEditHistory === true;
  const approvalValue = value.newMemberApprovalPosts;
  const newMemberApprovalPosts =
    approvalValue === undefined
      ? 0
      : typeof approvalValue === "number" &&
          Number.isInteger(approvalValue) &&
          approvalValue >= 0 &&
          approvalValue <= 1_000
        ? approvalValue
        : null;
  const retention = value.ipRetentionDays;
  const ipRetentionDays =
    retention === undefined
      ? 90
      : typeof retention === "number" &&
          Number.isInteger(retention) &&
          retention >= 1 &&
          retention <= 3_650
        ? retention
        : null;
  const reactionsAffectReputation = value.reactionsAffectReputation === true;
  const reputationDisplay = value.reputationDisplay !== false;
  const apiKeyRateLimitPerMinute = rateLimit(value.apiKeyRateLimitPerMinute, 60);
  const apiIpRateLimitPerMinute = rateLimit(value.apiIpRateLimitPerMinute, 120);
  let reputationLabelScale: readonly ReputationLabel[] = DEFAULT_REPUTATION_LABEL_SCALE;

  if (value.reputationLabelScale !== undefined) {
    const parsedScale = parseReputationLabelScale(value.reputationLabelScale);

    if (parsedScale === null) {
      fields.push("reputationLabelScale");
    } else {
      reputationLabelScale = parsedScale;
    }
  }
  const rawAttachmentTypes = value.attachmentAllowedTypes;
  let attachmentAllowedTypes: readonly AttachmentContentType[] = DEFAULT_ATTACHMENT_TYPES;

  if (rawAttachmentTypes !== undefined) {
    if (
      !Array.isArray(rawAttachmentTypes) ||
      !rawAttachmentTypes.every((entry) => typeof entry === "string")
    ) {
      fields.push("attachmentAllowedTypes");
    } else {
      attachmentAllowedTypes = canonicalAttachmentTypes(rawAttachmentTypes);

      if (attachmentAllowedTypes.length !== new Set(rawAttachmentTypes).size) {
        fields.push("attachmentAllowedTypes");
      }
    }
  }

  if (topicsPerPage === null) {
    fields.push("topicsPerPage");
  }

  if (postsPerPage === null) {
    fields.push("postsPerPage");
  }

  if (newMemberApprovalPosts === null) {
    fields.push("newMemberApprovalPosts");
  }

  if (ipRetentionDays === null) {
    fields.push("ipRetentionDays");
  }

  if (apiKeyRateLimitPerMinute === null) {
    fields.push("apiKeyRateLimitPerMinute");
  }

  if (apiIpRateLimitPerMinute === null) {
    fields.push("apiIpRateLimitPerMinute");
  }

  if (value.defaultLocale !== undefined && !isLocale(String(value.defaultLocale))) {
    fields.push("defaultLocale");
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return {
    ok: true,
    value: {
      boardName,
      boardDescription,
      defaultLocale,
      offline,
      offlineMessage,
      topicsPerPage: topicsPerPage ?? 20,
      postsPerPage: postsPerPage ?? 20,
      publicEditHistory,
      newMemberApprovalPosts: newMemberApprovalPosts ?? 0,
      ipRetentionDays: ipRetentionDays ?? 90,
      attachmentAllowedTypes,
      reactionsAffectReputation,
      reputationDisplay,
      reputationLabelScale,
      apiKeyRateLimitPerMinute: apiKeyRateLimitPerMinute ?? 60,
      apiIpRateLimitPerMinute: apiIpRateLimitPerMinute ?? 120,
    },
  };
}

/** API rate limits default on, so an omitted field keeps the current default. */
function rateLimit(value: unknown, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }

  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000
    ? value
    : null;
}

/**
 * Validates the staff scale: every shipped label exactly once, integer thresholds in range.
 * The canonical order is ascending, so the last matching threshold is the most specific.
 */
function parseReputationLabelScale(value: unknown): readonly ReputationLabel[] | null {
  if (!Array.isArray(value) || value.length !== REPUTATION_LABEL_KEYS.length) {
    return null;
  }

  const labels: ReputationLabel[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }

    const record = entry as { readonly min?: unknown; readonly labelKey?: unknown };

    if (
      typeof record.min !== "number" ||
      !Number.isInteger(record.min) ||
      record.min < -1_000_000 ||
      record.min > 1_000_000 ||
      typeof record.labelKey !== "string" ||
      !isReputationLabelKey(record.labelKey) ||
      seen.has(record.labelKey)
    ) {
      return null;
    }

    seen.add(record.labelKey);
    labels.push({ min: record.min, labelKey: record.labelKey });
  }

  if (seen.size !== REPUTATION_LABEL_KEYS.length) {
    return null;
  }

  return labels.sort((left, right) => left.min - right.min);
}
