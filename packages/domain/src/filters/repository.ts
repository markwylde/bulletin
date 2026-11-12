import { bumpCacheTags } from "@bulletin/cache";
import type { ReplaceWords } from "@bulletin/content";
import { contentLinkHosts } from "@bulletin/content";
import type { SQL } from "bun";
import { loadMergedGroupSettings } from "../permissions/store.ts";
import { countRecentPostsByAuthor } from "../topics/repository.ts";

export interface FilterSettings {
  readonly version: string;
  readonly duplicateEnabled: boolean;
  readonly duplicateCount: number;
  readonly duplicateWindowMinutes: number;
  readonly rateEnabled: boolean;
  readonly rateCount: number;
  readonly rateMinutes: number;
}

export interface FilterWordRecord {
  readonly id: string;
  readonly word: string;
  readonly mode: "block" | "replace";
  readonly replacement: string;
  readonly matchMode: "whole" | "any";
  readonly enabled: boolean;
}

export interface FilterDomainRecord {
  readonly id: string;
  readonly domain: string;
  readonly enabled: boolean;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value.trim()
    : null;
}

async function bumpFilterVersion(tx: SQL): Promise<void> {
  await tx`UPDATE core.filter_settings SET version = version + 1, updated_at = now() WHERE id = 1`;
  await bumpCacheTags(tx, ["filters"]);
}

export async function saveFilterWord(
  sql: SQL,
  input: unknown,
): Promise<
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: string }
> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const record = input as Record<string, unknown>;
  const word = text(record.word, 120);
  const mode = record.mode === "replace" ? "replace" : record.mode === "block" ? "block" : null;
  const matchMode = record.matchMode === "any" ? "any" : "whole";
  const replacement = mode === "replace" ? text(record.replacement, 120) : "";
  const enabled = record.enabled !== false;

  if (word === null || mode === null || replacement === null) {
    return { ok: false, code: "invalid_request" };
  }

  return sql.begin(async (tx) => {
    const rows = (await (typeof record.id === "string" && /^\d+$/.test(record.id)
      ? tx`
          UPDATE core.filter_words
          SET word = ${word}, mode = ${mode}, replacement = ${replacement},
              match_mode = ${matchMode}, enabled = ${enabled}, updated_at = now()
          WHERE id = ${record.id}
          RETURNING id::text AS id
        `
      : tx`
          INSERT INTO core.filter_words (word, mode, replacement, match_mode, enabled)
          VALUES (${word}, ${mode}, ${replacement}, ${matchMode}, ${enabled})
          RETURNING id::text AS id
        `)) as Array<{ id: string }>;
    const id = rows[0]?.id;

    if (id === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    await bumpFilterVersion(tx);
    return { ok: true as const, id };
  });
}

export async function deleteFilterWord(sql: SQL, id: string): Promise<{ readonly ok: boolean }> {
  if (!/^\d+$/.test(id)) {
    return { ok: false };
  }

  return sql.begin(async (tx) => {
    const rows =
      (await tx`DELETE FROM core.filter_words WHERE id = ${id} RETURNING 1`) as unknown[];

    if (rows.length > 0) {
      await bumpFilterVersion(tx);
    }

    return { ok: rows.length > 0 };
  });
}

export async function saveFilterDomain(
  sql: SQL,
  input: unknown,
): Promise<
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: string }
> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "invalid_request" };
  }

  const record = input as Record<string, unknown>;
  let domain = text(record.domain, 200)?.toLowerCase() ?? null;
  domain =
    domain
      ?.replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "") ?? null;

  if (domain === null || !/^[a-z0-9.-]+$/.test(domain)) {
    return { ok: false, code: "invalid_request" };
  }

  const enabled = record.enabled !== false;
  const rows = (await (typeof record.id === "string" && /^\d+$/.test(record.id)
    ? sql`
        UPDATE core.filter_domains SET domain = ${domain}, enabled = ${enabled}
        WHERE id = ${record.id} RETURNING id::text AS id
      `
    : sql`
        INSERT INTO core.filter_domains (domain, enabled) VALUES (${domain}, ${enabled})
        RETURNING id::text AS id
      `)) as Array<{ id: string }>;

  return rows[0] === undefined ? { ok: false, code: "not_found" } : { ok: true, id: rows[0].id };
}

export async function deleteFilterDomain(sql: SQL, id: string): Promise<{ readonly ok: boolean }> {
  if (!/^\d+$/.test(id)) {
    return { ok: false };
  }

  const rows = (await sql`
    DELETE FROM core.filter_domains WHERE id = ${id} RETURNING 1
  `) as unknown[];

  return { ok: rows.length > 0 };
}

export async function saveFilterSettings(sql: SQL, input: unknown): Promise<FilterSettings | null> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const record = input as Record<string, unknown>;

  if (
    typeof record.duplicateEnabled !== "boolean" ||
    typeof record.duplicateCount !== "number" ||
    !Number.isInteger(record.duplicateCount) ||
    record.duplicateCount < 2 ||
    record.duplicateCount > 100 ||
    typeof record.duplicateWindowMinutes !== "number" ||
    !Number.isInteger(record.duplicateWindowMinutes) ||
    record.duplicateWindowMinutes < 1 ||
    record.duplicateWindowMinutes > 1_440 ||
    typeof record.rateEnabled !== "boolean" ||
    typeof record.rateCount !== "number" ||
    !Number.isInteger(record.rateCount) ||
    record.rateCount < 2 ||
    record.rateCount > 1_000 ||
    typeof record.rateMinutes !== "number" ||
    !Number.isInteger(record.rateMinutes) ||
    record.rateMinutes < 1 ||
    record.rateMinutes > 1_440
  ) {
    return null;
  }

  await sql`
    UPDATE core.filter_settings
    SET duplicate_enabled = ${record.duplicateEnabled},
        duplicate_count = ${record.duplicateCount},
        duplicate_window_minutes = ${record.duplicateWindowMinutes},
        rate_enabled = ${record.rateEnabled},
        rate_count = ${record.rateCount},
        rate_minutes = ${record.rateMinutes},
        updated_at = now()
    WHERE id = 1
  `;

  return readFilterSettings(sql);
}

export interface LinkPolicy {
  readonly maxLinks: number;
  readonly imagesAllowed: boolean;
  readonly action: "reject" | "hold";
  readonly exempt: boolean;
}

export interface SpamVerdict {
  /** The rule label stored in `hold_reason`, or null when nothing flagged the content. */
  readonly rule: "duplicate" | "rate" | "domain_blocklist" | null;
}

export async function readFilterSettings(sql: SQL): Promise<FilterSettings> {
  const [row] = (await sql`
    SELECT version::text AS version, duplicate_enabled, duplicate_count,
      duplicate_window_minutes, rate_enabled, rate_count, rate_minutes
    FROM core.filter_settings WHERE id = 1
  `) as Array<{
    version: string;
    duplicate_enabled: boolean;
    duplicate_count: number;
    duplicate_window_minutes: number;
    rate_enabled: boolean;
    rate_count: number;
    rate_minutes: number;
  }>;

  return {
    version: row?.version ?? "0",
    duplicateEnabled: row?.duplicate_enabled ?? false,
    duplicateCount: row?.duplicate_count ?? 2,
    duplicateWindowMinutes: row?.duplicate_window_minutes ?? 10,
    rateEnabled: row?.rate_enabled ?? false,
    rateCount: row?.rate_count ?? 5,
    rateMinutes: row?.rate_minutes ?? 1,
  };
}

export async function listFilterWords(sql: SQL): Promise<readonly FilterWordRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, word, mode, replacement, match_mode, enabled
    FROM core.filter_words ORDER BY lower(word), id
  `) as Array<{
    id: string;
    word: string;
    mode: FilterWordRecord["mode"];
    replacement: string;
    match_mode: FilterWordRecord["matchMode"];
    enabled: boolean;
  }>;

  return rows.map((row) => ({
    id: row.id,
    word: row.word,
    mode: row.mode,
    replacement: row.replacement,
    matchMode: row.match_mode,
    enabled: row.enabled,
  }));
}

export async function listFilterDomains(sql: SQL): Promise<readonly FilterDomainRecord[]> {
  const rows = (await sql`
    SELECT id::text AS id, domain, enabled FROM core.filter_domains ORDER BY domain
  `) as Array<{ id: string; domain: string; enabled: boolean }>;

  return rows;
}

/** The render-time replace list plus its version, which feeds `render_version`. */
export async function loadReplaceWords(sql: SQL): Promise<ReplaceWords> {
  const settings = await readFilterSettings(sql);
  const rows = (await sql`
    SELECT word, replacement FROM core.filter_words
    WHERE mode = 'replace' AND enabled
    ORDER BY lower(word)
  `) as Array<{ word: string; replacement: string }>;

  return {
    version: Number(settings.version),
    rules: rows.map((row) => ({ word: row.word, replacement: row.replacement })),
  };
}

export async function loadBlockWords(
  sql: SQL,
): Promise<{ readonly whole: readonly string[]; readonly any: readonly string[] }> {
  const rows = (await sql`
    SELECT word, match_mode FROM core.filter_words
    WHERE mode = 'block' AND enabled
    ORDER BY lower(word)
  `) as Array<{ word: string; match_mode: "whole" | "any" }>;

  return {
    whole: rows.filter((row) => row.match_mode === "whole").map((row) => row.word),
    any: rows.filter((row) => row.match_mode === "any").map((row) => row.word),
  };
}

/** Blocked-word check for plain text (titles, names, labels), not markdown. */
export async function isBlockedText(sql: SQL, value: string): Promise<boolean> {
  const words = await loadBlockWords(sql);
  const lower = value.toLowerCase();

  if (words.any.some((word) => lower.includes(word.toLowerCase()))) {
    return true;
  }

  return words.whole.some((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(value);
  });
}

export async function readLinkPolicy(sql: SQL, memberId: string): Promise<LinkPolicy> {
  const settings = await loadMergedGroupSettings(sql, memberId);
  const maxLinks = Number(settings["posting.link_limit"] ?? 0);
  const exempt = settings["posting.link_limit_exempt"] === true;
  const action = settings["posting.link_limit_action"] === "reject" ? "reject" : "hold";
  const imagesAllowed = settings["posting.link_limit_images"] !== false;
  const minPosts = Number(settings["posting.link_limit_min_posts"] ?? 0);
  const minDays = Number(settings["posting.link_limit_min_days"] ?? 0);
  const [member] = (await sql`
    SELECT post_count,
      EXTRACT(EPOCH FROM (now() - joined_at)) / 86_400 AS age_days
    FROM core.members WHERE id = ${memberId}
  `) as Array<{ post_count: number; age_days: string }>;
  const postCount = member?.post_count ?? 0;
  const ageDays = Number(member?.age_days ?? 0);
  const applies =
    minPosts === 0 && minDays === 0
      ? true
      : (minPosts > 0 && postCount < minPosts) || (minDays > 0 && ageDays < minDays);

  return {
    maxLinks: applies ? maxLinks : 0,
    imagesAllowed,
    action,
    exempt,
  };
}

function normaliseBodyText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function bodyHash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(normaliseBodyText(value)).digest("hex");
}

export async function recordDuplicate(sql: SQL, authorId: string, hash: string): Promise<void> {
  await sql`
    INSERT INTO core.filter_duplicates (author_id, body_hash)
    VALUES (${authorId}, ${hash})
  `;
  await sql`DELETE FROM core.filter_duplicates WHERE created_at < now() - interval '1 day'`;
}

/** Runs the enabled duplicate, rate and domain rules; one label is returned for the queue. */
export async function evaluateSpam(
  sql: SQL,
  input: {
    readonly authorId: string;
    readonly bodyText: string;
    readonly bodyMd: string;
    readonly hash: string;
  },
): Promise<SpamVerdict> {
  const settings = await readFilterSettings(sql);
  const merged = await loadMergedGroupSettings(sql, input.authorId);

  if (merged["posting.spam_exempt"] === true) {
    return { rule: null };
  }

  if (settings.duplicateEnabled) {
    const [row] = (await sql`
      SELECT count(*)::int AS count FROM core.filter_duplicates
      WHERE author_id = ${input.authorId}
        AND body_hash = ${input.hash}
        AND created_at > now() - make_interval(mins => ${settings.duplicateWindowMinutes})
    `) as Array<{ count: number }>;

    if ((row?.count ?? 0) >= settings.duplicateCount - 1) {
      return { rule: "duplicate" };
    }
  }

  if (
    settings.rateEnabled &&
    (await countRecentPostsByAuthor(sql, input.authorId, settings.rateMinutes)) >=
      settings.rateCount
  ) {
    return { rule: "rate" };
  }

  const domains = (await sql`
    SELECT domain FROM core.filter_domains WHERE enabled
  `) as Array<{ domain: string }>;
  const hosts = contentLinkHosts(input.bodyMd);

  for (const host of hosts) {
    if (domains.some((row) => host === row.domain || host.endsWith(`.${row.domain}`))) {
      return { rule: "domain_blocklist" };
    }
  }

  return { rule: null };
}
