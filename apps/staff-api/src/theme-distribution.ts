import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";
import {
  type BundleInstallResult,
  exportThemeBundle,
  installMarketplaceTheme,
  installThemeBundle,
  marketplacePublicKey,
  marketplaceThemePackages,
  themeSigningKey,
} from "./theme-bundles.ts";

const MAX_BUNDLE_BASE64 = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 1024;

function respond(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function themeId(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

/** Marketplace base URL is deployment configuration; local compose sets the mock. */
function marketplaceUrl(): string {
  return Bun.env.BULLETIN_MARKETPLACE_URL?.trim() ?? "";
}

function installationFailure(result: Extract<BundleInstallResult, { ok: false }>): Response {
  const status =
    result.code === "duplicate_name"
      ? 409
      : result.code === "package_not_found"
        ? 404
        : result.code === "marketplace_unavailable"
          ? 503
          : 400;

  return respond(
    {
      code: result.code,
      ...(result.issues === undefined ? {} : { issues: result.issues }),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    },
    status,
  );
}

export async function exportThemeResponse(
  sql: SQL,
  storage: StorageClient,
  url: URL,
): Promise<Response> {
  const id = themeId(url.searchParams.get("id"));
  const key = themeSigningKey();

  if (id === null) {
    return respond({ code: "not_found" }, 404);
  }

  if (key === null) {
    return respond({ code: "signing_unavailable" }, 503);
  }

  const bundle = await exportThemeBundle(sql, storage, id, key);

  if (bundle === null) {
    return respond({ code: "not_found" }, 404);
  }

  return respond({
    ok: true,
    filename: bundle.filename,
    bundle: Buffer.from(bundle.bundle).toString("base64"),
    signature: bundle.signature,
  });
}

export async function importThemeResponse(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const key = marketplacePublicKey();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const record = body as Record<string, unknown>;
  const bundle =
    typeof record.bundle === "string" && record.bundle.length <= MAX_BUNDLE_BASE64
      ? record.bundle
      : null;
  const signature = typeof record.signature === "string" ? record.signature : null;

  if (bundle === null || signature === null) {
    return respond({ code: "invalid_request" }, 400);
  }

  if (key === null) {
    return respond({ code: "signature_unavailable" }, 503);
  }

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(Buffer.from(bundle, "base64"));
  } catch {
    return respond({ code: "invalid_bundle" }, 400);
  }

  const result = await installThemeBundle(sql, storage, actorId, bytes, signature, key, "upload");

  if (!result.ok) {
    return installationFailure(result);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.import",
    targetType: "theme",
    targetId: result.id,
    summary: { source: "upload" },
  });

  return respond({ ok: true, id: result.id });
}

export async function marketplaceListResponse(): Promise<Response> {
  const key = marketplacePublicKey();

  if (key === null) {
    return respond({ code: "signature_unavailable" }, 503);
  }

  const baseUrl = marketplaceUrl();

  if (baseUrl === "") {
    return respond({ code: "marketplace_unavailable" }, 503);
  }

  const packages = await marketplaceThemePackages(baseUrl, key);

  return packages === null
    ? respond({ code: "marketplace_unavailable" }, 503)
    : respond({ packages });
}

export async function marketplaceInstallResponse(
  sql: SQL,
  storage: StorageClient,
  actorId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const key = marketplacePublicKey();

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return respond({ code: "invalid_request" }, 400);
  }

  const packageId = (body as Record<string, unknown>).packageId;

  if (typeof packageId !== "string" || packageId.length > 100) {
    return respond({ code: "invalid_request" }, 400);
  }

  if (key === null) {
    return respond({ code: "signature_unavailable" }, 503);
  }

  const baseUrl = marketplaceUrl();

  if (baseUrl === "") {
    return respond({ code: "marketplace_unavailable" }, 503);
  }

  const result = await installMarketplaceTheme(sql, storage, actorId, {
    baseUrl,
    packageId,
    publicKey: key,
  });

  if (!result.ok) {
    return installationFailure(result);
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "theme.marketplace.install",
    targetType: "theme",
    targetId: result.id,
    summary: { packageId },
  });

  return respond({ ok: true, id: result.id });
}
