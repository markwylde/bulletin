import type { EmbedProvider } from "@bulletin/content/types";
import type { SQL } from "bun";

export interface EmbedProviderRecord extends EmbedProvider {
  readonly id: string;
  readonly enabled: boolean;
  readonly position: number;
}

export interface EmbedProviderInput {
  readonly key: string;
  readonly title: string;
  readonly urlPattern: string;
  readonly embedUrl: string;
  readonly enabled: boolean;
  readonly position: number;
}

export type EmbedProviderParse =
  | { readonly ok: true; readonly value: EmbedProviderInput }
  | { readonly ok: false; readonly fields: readonly string[] };

export interface EmbedProviderMutation {
  readonly ok: true;
  readonly provider?: EmbedProviderRecord;
}

export type EmbedProviderResult =
  | EmbedProviderMutation
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found";
      readonly fields?: readonly string[];
    };

interface EmbedProviderRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly url_pattern: string;
  readonly embed_url: string;
  readonly enabled: boolean;
  readonly position: number;
}

function toRecord(row: EmbedProviderRow): EmbedProviderRecord {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    urlPattern: row.url_pattern,
    embedUrl: row.embed_url,
    enabled: row.enabled,
    position: row.position,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

function safeTemplate(value: string): boolean {
  if (!value.includes("{id}")) {
    return false;
  }

  try {
    const url = new URL(value.replaceAll("{id}", "test"));
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Validates an admin provider before it can reach the renderer. */
export function parseEmbedProviderInput(value: unknown): EmbedProviderParse {
  if (!isRecord(value)) {
    return { ok: false, fields: ["form"] };
  }

  const fields: string[] = [];
  const key = typeof value.key === "string" ? value.key.trim().toLowerCase() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const urlPattern = typeof value.urlPattern === "string" ? value.urlPattern.trim() : "";
  const embedUrl = typeof value.embedUrl === "string" ? value.embedUrl.trim() : "";
  const enabled = value.enabled !== false;
  const position =
    typeof value.position === "number" && Number.isInteger(value.position) && value.position >= 0
      ? value.position
      : 0;

  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) {
    fields.push("key");
  }

  if (title.length === 0 || title.length > 100) {
    fields.push("title");
  }

  if (urlPattern.length === 0 || urlPattern.length > 500 || !compiles(urlPattern)) {
    fields.push("urlPattern");
  }

  if (!safeTemplate(embedUrl)) {
    fields.push("embedUrl");
  }

  if (value.position !== undefined && position === 0 && value.position !== 0) {
    fields.push("position");
  }

  if (fields.length > 0) {
    return { ok: false, fields };
  }

  return { ok: true, value: { key, title, urlPattern, embedUrl, enabled, position } };
}

/** Enabled providers for the renderer, in admin display order. */
export async function listEmbedProviders(
  sql: SQL,
  options: { readonly includeDisabled?: boolean } = {},
): Promise<readonly EmbedProviderRecord[]> {
  const rows = (
    options.includeDisabled === true
      ? await sql`
          SELECT id::text AS id, key, title, url_pattern, embed_url, enabled, position
          FROM core.embed_providers
          ORDER BY position, id
        `
      : await sql`
          SELECT id::text AS id, key, title, url_pattern, embed_url, enabled, position
          FROM core.embed_providers
          WHERE enabled
          ORDER BY position, id
        `
  ) as EmbedProviderRow[];

  return rows.map(toRecord);
}

export async function saveEmbedProvider(sql: SQL, value: unknown): Promise<EmbedProviderResult> {
  const parsed = parseEmbedProviderInput(value);

  if (!parsed.ok) {
    return { ok: false, code: "invalid", fields: parsed.fields };
  }

  const input = parsed.value;
  const [row] = (await sql`
    INSERT INTO core.embed_providers (key, title, url_pattern, embed_url, enabled, position)
    VALUES (
      ${input.key}, ${input.title}, ${input.urlPattern}, ${input.embedUrl},
      ${input.enabled}, ${input.position}
    )
    ON CONFLICT (key) DO UPDATE
      SET title = EXCLUDED.title,
        url_pattern = EXCLUDED.url_pattern,
        embed_url = EXCLUDED.embed_url,
        enabled = EXCLUDED.enabled,
        position = EXCLUDED.position,
        updated_at = now()
    RETURNING id::text AS id, key, title, url_pattern, embed_url, enabled, position
  `) as Array<EmbedProviderRow>;

  return row === undefined ? { ok: false, code: "invalid" } : { ok: true, provider: toRecord(row) };
}

export async function deleteEmbedProvider(sql: SQL, key: string): Promise<EmbedProviderResult> {
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) {
    return { ok: false, code: "invalid", fields: ["key"] };
  }

  const rows = (await sql`
    DELETE FROM core.embed_providers
    WHERE key = ${key}
    RETURNING id
  `) as Array<{ id: string }>;

  return rows.length === 0 ? { ok: false, code: "not_found" } : { ok: true };
}
