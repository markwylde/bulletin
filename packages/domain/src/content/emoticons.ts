import type { SQL } from "bun";

export const EMOTICON_CODE = /^[a-z0-9_+-]{1,32}$/;
export const EMOTICON_KEY = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const EMOTICON_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type EmoticonContentType = (typeof EMOTICON_CONTENT_TYPES)[number];

export interface EmoticonRecord {
  readonly id: string;
  readonly setId: string;
  readonly code: string;
  readonly alt: string;
  readonly storageKey: string;
  readonly contentType: EmoticonContentType;
  readonly position: number;
}

export interface EmoticonSetRecord {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly position: number;
  readonly editorVisible: boolean;
  readonly emoticons: readonly EmoticonRecord[];
}

export interface EditorEmoticon {
  readonly code: string;
  readonly src: string;
  readonly alt: string;
}

export interface EditorEmoticonSet {
  readonly key: string;
  readonly title: string;
  readonly emoticons: readonly EditorEmoticon[];
}

export type EmoticonMutation =
  | { readonly ok: true; readonly id?: string }
  | {
      readonly ok: false;
      readonly code: "invalid" | "not_found" | "duplicate_code" | "duplicate_key";
      readonly fields?: readonly string[];
    };

interface SetRow {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly position: number;
  readonly editor_visible: boolean;
}

interface EmoticonRow {
  readonly id: string;
  readonly set_id: string;
  readonly code: string;
  readonly alt: string;
  readonly storage_key: string;
  readonly content_type: EmoticonContentType;
  readonly position: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setRecord(row: SetRow, emoticons: readonly EmoticonRecord[]): EmoticonSetRecord {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    position: row.position,
    editorVisible: row.editor_visible,
    emoticons,
  };
}

function emoticonRecord(row: EmoticonRow): EmoticonRecord {
  return {
    id: row.id,
    setId: row.set_id,
    code: row.code,
    alt: row.alt,
    storageKey: row.storage_key,
    contentType: row.content_type,
    position: row.position,
  };
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

/** Every set and its emoticons for the staff manager. */
export async function listEmoticonSets(sql: SQL): Promise<readonly EmoticonSetRecord[]> {
  const sets = (await sql`
    SELECT id::text AS id, key, title, position, editor_visible
    FROM core.emoticon_sets
    ORDER BY position, id
  `) as SetRow[];
  const rows = (await sql`
    SELECT id::text AS id, set_id::text AS set_id, code, alt, storage_key, content_type, position
    FROM core.emoticons
    ORDER BY set_id, position, id
  `) as EmoticonRow[];
  const bySet = new Map<string, EmoticonRecord[]>();

  for (const row of rows) {
    const list = bySet.get(row.set_id) ?? [];
    list.push(emoticonRecord(row));
    bySet.set(row.set_id, list);
  }

  return sets.map((row) => setRecord(row, bySet.get(row.id) ?? []));
}

/** Only editor-visible sets reach the editor; every code is globally unique. */
export async function listEditorEmoticons(sql: SQL): Promise<readonly EditorEmoticonSet[]> {
  const sets = (await sql`
    SELECT id::text AS id, key, title, position, editor_visible
    FROM core.emoticon_sets
    WHERE editor_visible
    ORDER BY position, id
  `) as SetRow[];
  const rows = (await sql`
    SELECT id::text AS id, set_id::text AS set_id, code, alt, storage_key, content_type, position
    FROM core.emoticons
    ORDER BY set_id, position, id
  `) as EmoticonRow[];
  const bySet = new Map<string, EditorEmoticon[]>();

  for (const row of rows) {
    const list = bySet.get(row.set_id) ?? [];
    list.push({ code: row.code, alt: row.alt, src: `/api/emoticons/${row.id}/image` });
    bySet.set(row.set_id, list);
  }

  return sets.map((row) => ({
    key: row.key,
    title: row.title,
    emoticons: bySet.get(row.id) ?? [],
  }));
}

export async function saveEmoticonSet(sql: SQL, value: unknown): Promise<EmoticonMutation> {
  if (!isRecord(value)) {
    return { ok: false, code: "invalid", fields: ["form"] };
  }

  const key = typeof value.key === "string" ? value.key.trim().toLowerCase() : "";
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const position =
    typeof value.position === "number" && Number.isInteger(value.position) && value.position >= 0
      ? value.position
      : 0;
  const editorVisible = value.editorVisible !== false;
  const fields: string[] = [];

  if (!EMOTICON_KEY.test(key)) {
    fields.push("key");
  }

  if (title.length === 0 || title.length > 100) {
    fields.push("title");
  }

  if (value.position !== undefined && position === 0 && value.position !== 0) {
    fields.push("position");
  }

  if (fields.length > 0) {
    return { ok: false, code: "invalid", fields };
  }

  try {
    const [row] = (await sql`
      INSERT INTO core.emoticon_sets (key, title, position, editor_visible)
      VALUES (${key}, ${title}, ${position}, ${editorVisible})
      ON CONFLICT (key) DO UPDATE
        SET title = EXCLUDED.title,
          position = EXCLUDED.position,
          editor_visible = EXCLUDED.editor_visible,
          updated_at = now()
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    return row === undefined ? { ok: false, code: "invalid" } : { ok: true, id: row.id };
  } catch (error) {
    return uniqueViolation(error)
      ? { ok: false, code: "duplicate_key", fields: ["key"] }
      : { ok: false, code: "invalid" };
  }
}

export async function deleteEmoticonSet(sql: SQL, id: string): Promise<EmoticonMutation> {
  if (!/^\d+$/.test(id)) {
    return { ok: false, code: "invalid", fields: ["id"] };
  }

  const rows = (await sql`
    DELETE FROM core.emoticon_sets WHERE id = ${id} RETURNING id
  `) as Array<{ id: string }>;

  return rows.length === 0 ? { ok: false, code: "not_found" } : { ok: true };
}

export interface SaveEmoticonInput {
  readonly id?: string;
  readonly setId: string;
  readonly code: string;
  readonly alt: string;
  readonly storageKey: string;
  readonly contentType: EmoticonContentType;
  readonly position: number;
}

/** Saves one emoticon; a duplicate code is rejected before the storage object is committed. */
export async function saveEmoticon(sql: SQL, value: SaveEmoticonInput): Promise<EmoticonMutation> {
  const fields: string[] = [];

  if (!/^\d+$/.test(value.setId)) {
    fields.push("setId");
  }

  if (!EMOTICON_CODE.test(value.code)) {
    fields.push("code");
  }

  if (value.alt.trim().length === 0 || value.alt.trim().length > 100) {
    fields.push("alt");
  }

  if (value.storageKey.trim() === "" || !EMOTICON_CONTENT_TYPES.includes(value.contentType)) {
    fields.push("image");
  }

  if (!Number.isInteger(value.position) || value.position < 0) {
    fields.push("position");
  }

  if (fields.length > 0) {
    return { ok: false, code: "invalid", fields };
  }

  const [set] = (await sql`
    SELECT id FROM core.emoticon_sets WHERE id = ${value.setId}
  `) as Array<{ id: string }>;

  if (set === undefined) {
    return { ok: false, code: "not_found", fields: ["setId"] };
  }

  const [duplicate] = (await sql`
    SELECT id FROM core.emoticons
    WHERE code = ${value.code} AND id <> ${value.id ?? "0"}
  `) as Array<{ id: string }>;

  if (duplicate !== undefined) {
    return { ok: false, code: "duplicate_code", fields: ["code"] };
  }

  try {
    const [row] = (await sql`
      INSERT INTO core.emoticons (
        set_id, code, alt, storage_key, content_type, position
      )
      VALUES (
        ${value.setId}, ${value.code}, ${value.alt.trim()}, ${value.storageKey},
        ${value.contentType}, ${value.position}
      )
      ON CONFLICT (id) DO UPDATE
        SET set_id = EXCLUDED.set_id,
          code = EXCLUDED.code,
          alt = EXCLUDED.alt,
          storage_key = EXCLUDED.storage_key,
          content_type = EXCLUDED.content_type,
          position = EXCLUDED.position,
          updated_at = now()
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    return row === undefined ? { ok: false, code: "invalid" } : { ok: true, id: row.id };
  } catch (error) {
    return uniqueViolation(error)
      ? { ok: false, code: "duplicate_code", fields: ["code"] }
      : { ok: false, code: "invalid" };
  }
}

export async function deleteEmoticon(sql: SQL, id: string): Promise<EmoticonMutation> {
  if (!/^\d+$/.test(id)) {
    return { ok: false, code: "invalid", fields: ["id"] };
  }

  const rows = (await sql`
    DELETE FROM core.emoticons WHERE id = ${id} RETURNING id
  `) as Array<{ id: string }>;

  return rows.length === 0 ? { ok: false, code: "not_found" } : { ok: true };
}

export async function readEmoticonImage(
  sql: SQL,
  id: string,
): Promise<{ readonly storageKey: string; readonly contentType: EmoticonContentType } | null> {
  if (!/^\d+$/.test(id)) {
    return null;
  }

  const [row] = (await sql`
    SELECT storage_key, content_type FROM core.emoticons WHERE id = ${id}
  `) as Array<{ storage_key: string; content_type: EmoticonContentType }>;

  return row === undefined ? null : { storageKey: row.storage_key, contentType: row.content_type };
}
