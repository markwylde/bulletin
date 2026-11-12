import {
  createChildTheme,
  createThemePreviewToken,
  deleteThemeAsset,
  grantPreviewTheme,
  listThemes,
  readThemeDetail,
  restoreThemeTemplateVersion,
  revertThemeTemplate,
  saveThemeAsset,
  saveThemeCss,
  saveThemeStrings,
  saveThemeTemplate,
  saveThemeTokens,
  type ThemeAssetInput,
  type ThemeStringInput,
  validTemplateName,
  validThemeName,
  verifyThemePreviewToken,
} from "@bulletin/domain/themes";
import { filterThemeCss } from "@bulletin/domain/themes/css";
import { opaqueKey, type StorageClient } from "@bulletin/storage";
import {
  createTemplateEngine,
  declaredHooks,
  HOOK_NAMES,
  validateTemplateMarkup,
} from "@bulletin/templates";
import type { SQL } from "bun";
import { fileTypeFromBuffer } from "file-type";
import { writeAdminLog } from "./admin-log.ts";

const MAX_TEMPLATE_BYTES = 1_000_000;
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BASE64 = Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 1024;
const ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
  "font/woff",
  "font/woff2",
  "font/ttf",
  "font/otf",
]);

const engine = createTemplateEngine({ islands: {} });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function themeId(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function respond(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function failure(code: string): Response {
  const status =
    code === "not_found"
      ? 404
      : code === "duplicate_name"
        ? 409
        : code === "protected_theme"
          ? 403
          : 400;

  return respond({ code }, status);
}

function invalidTemplate(
  issues: ReturnType<typeof validateTemplateMarkup>["issues"],
  parseError: string | null,
  unknownHooks: readonly string[],
): Response {
  return respond(
    {
      code: "invalid_template",
      issues,
      ...(parseError === null ? {} : { parseError }),
      ...(unknownHooks.length === 0 ? {} : { unknownHooks }),
    },
    400,
  );
}

function checkTemplate(body: string): {
  readonly parseError: string | null;
  readonly issues: ReturnType<typeof validateTemplateMarkup>["issues"];
  readonly unknownHooks: readonly string[];
} {
  const validation = validateTemplateMarkup(body);
  let parseError: string | null = null;

  try {
    engine.compile(body);
  } catch (error) {
    parseError = error instanceof Error ? error.message : "The template could not be parsed.";
  }

  const unknownHooks = declaredHooks(body).filter((hook) => !HOOK_NAMES.includes(hook));

  return { parseError, issues: validation.issues, unknownHooks };
}

export async function listThemesResponse(sql: SQL): Promise<Response> {
  return respond({ themes: await listThemes(sql) });
}

export async function themeDetailResponse(sql: SQL, url: URL): Promise<Response> {
  const id = themeId(url.searchParams.get("id"));

  if (id === null) {
    return failure("not_found");
  }

  const theme = await readThemeDetail(sql, id);

  return theme === null ? failure("not_found") : respond({ theme });
}

export async function createThemeResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const name = validThemeName(body.name);

  if (name === null) {
    return respond({ code: "invalid_name" }, 400);
  }

  const parentId = themeId(body.parentId);

  if (parentId === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  const outcome = await createChildTheme(sql, { name, parentId, actorId });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.create",
    targetType: "theme",
    targetId: outcome.result.id,
    summary: { name, parentId },
  });

  return respond({ ok: true, id: outcome.result.id });
}

export async function saveTemplateResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const name = validTemplateName(body.name);
  const source = text(body.body, MAX_TEMPLATE_BYTES);

  if (theme === null || name === null || source === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  const check = checkTemplate(source);

  if (check.issues.length > 0 || check.parseError !== null || check.unknownHooks.length > 0) {
    return invalidTemplate(check.issues, check.parseError, check.unknownHooks);
  }

  const outcome = await saveThemeTemplate(sql, {
    themeId: theme,
    name,
    body: source,
    actorId,
  });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.template.save",
    targetType: "theme_template",
    targetId: theme,
    summary: { name, version: outcome.result.version },
  });

  return respond({ ok: true, version: outcome.result.version });
}

export async function restoreTemplateResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const name = validTemplateName(body.name);
  const version = typeof body.version === "number" ? body.version : Number.NaN;

  if (theme === null || name === null || !Number.isSafeInteger(version)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const outcome = await restoreThemeTemplateVersion(sql, {
    themeId: theme,
    name,
    version,
    actorId,
  });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.template.restore",
    targetType: "theme_template",
    targetId: theme,
    summary: { name, restoredVersion: version, version: outcome.result.version },
  });

  return respond({ ok: true, version: outcome.result.version });
}

export async function revertTemplateResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const name = validTemplateName(body.name);

  if (theme === null || name === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  const outcome = await revertThemeTemplate(sql, { themeId: theme, name, actorId });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.template.revert",
    targetType: "theme_template",
    targetId: theme,
    summary: { name },
  });

  return respond({ ok: true });
}

export async function saveTokensResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const scheme = body.scheme;

  if (theme === null || (scheme !== "light" && scheme !== "dark")) {
    return respond({ code: "invalid_request" }, 400);
  }

  const outcome = await saveThemeTokens(sql, { themeId: theme, scheme, tokens: body.tokens });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.tokens.save",
    targetType: "theme",
    targetId: theme,
    summary: { scheme },
  });

  return respond({ ok: true });
}

export async function saveCssResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const source = text(body.css, 200_000);

  if (theme === null || source === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  const filtered = filterThemeCss(source);

  if (!filtered.ok) {
    return respond({ code: `css_${filtered.code}`, detail: filtered.detail ?? null }, 400);
  }

  const outcome = await saveThemeCss(sql, { themeId: theme, css: filtered.css });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.css.save",
    targetType: "theme",
    targetId: theme,
    summary: { bytes: filtered.css.length },
  });

  return respond({ ok: true, css: filtered.css });
}

export async function saveStringsResponse(
  sql: SQL,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || !Array.isArray(body.strings)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);

  if (theme === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  const strings: ThemeStringInput[] = [];

  for (const entry of body.strings) {
    if (!isRecord(entry)) {
      return respond({ code: "invalid_request" }, 400);
    }

    const locale = entry.locale;
    const key = text(entry.key, 160);
    const value = text(entry.value, 5_000);

    if ((locale !== "en" && locale !== "es" && locale !== "fr") || key === null || value === null) {
      return respond({ code: "invalid_request" }, 400);
    }

    strings.push({ locale, key, value });
  }

  const outcome = await saveThemeStrings(sql, { themeId: theme, strings });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.strings.save",
    targetType: "theme",
    targetId: theme,
    summary: { count: strings.length },
  });

  return respond({ ok: true });
}

export async function uploadAssetResponse(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const name = text(body.name, 100);
  const data = text(body.data, MAX_ASSET_BASE64);

  if (theme === null || name === null || data === null || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const bytes = Buffer.from(data, "base64");

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) {
    return respond({ code: "invalid_asset" }, 400);
  }

  const detected = await fileTypeFromBuffer(bytes);

  if (detected === undefined || !ASSET_TYPES.has(detected.mime)) {
    return respond({ code: "invalid_asset" }, 400);
  }

  const key = opaqueKey("theme");
  await storage.put(key, new Uint8Array(bytes), { contentType: detected.mime });

  const input: ThemeAssetInput = {
    themeId: theme,
    name,
    contentType: detected.mime,
    bytes: bytes.byteLength,
    storageKey: key,
    actorId,
  };
  const outcome = await saveThemeAsset(sql, input);

  if (!outcome.ok) {
    await storage.delete(key).catch(() => undefined);
    return failure(outcome.code);
  }

  if (outcome.result.replacedStorageKey !== undefined) {
    await storage.delete(outcome.result.replacedStorageKey).catch(() => undefined);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.asset.upload",
    targetType: "theme_asset",
    targetId: outcome.result.id,
    summary: { themeId: theme, name, contentType: detected.mime, bytes: bytes.byteLength },
  });

  return respond({
    ok: true,
    asset: { id: outcome.result.id, name, contentType: detected.mime, bytes: bytes.byteLength },
  });
}

export async function deleteAssetResponse(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const theme = themeId(body.themeId);
  const asset = themeId(body.assetId);

  if (theme === null || asset === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  const outcome = await deleteThemeAsset(sql, { themeId: theme, assetId: asset });

  if (!outcome.ok) {
    return failure(outcome.code);
  }

  await storage.delete(outcome.result.storageKey).catch(() => undefined);
  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.asset.delete",
    targetType: "theme_asset",
    targetId: asset,
    summary: { themeId: theme },
  });

  return respond({ ok: true });
}

export interface ThemePreviewResponseInput {
  readonly themeId: string;
  readonly memberId: string;
  readonly secret: string;
  readonly userOrigin: string;
  readonly returnTo: string | null;
}

/** Issues a short-lived signed token the admin opens on the user origin (ADR 0008). */
export function themePreviewResponse(input: ThemePreviewResponseInput): Response {
  const token = createThemePreviewToken(
    { themeId: input.themeId, memberId: input.memberId },
    input.secret,
  );
  const returnTo =
    input.returnTo?.startsWith("/") === true && !input.returnTo.startsWith("//")
      ? input.returnTo
      : "/";
  const url = new URL("/_preview", input.userOrigin);
  url.searchParams.set("token", token);
  url.searchParams.set("return_to", returnTo);

  return respond({ ok: true, url: url.toString() });
}

/** Exchanges the signed token for the member's session grant (used by the user app). */
export async function exchangePreviewToken(
  sql: SQL,
  sessionId: string,
  memberId: string,
  secret: string,
  token: string,
): Promise<{ readonly ok: true; readonly themeId: string } | { readonly ok: false }> {
  const claims = verifyThemePreviewToken(token, secret);

  if (claims === null || claims.memberId !== memberId) {
    return { ok: false };
  }

  if (!(await grantPreviewTheme(sql, sessionId, claims.themeId))) {
    return { ok: false };
  }

  return { ok: true, themeId: claims.themeId };
}
