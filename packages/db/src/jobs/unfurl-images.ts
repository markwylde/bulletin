import { sha256Hex, UNFURL_IMAGE_MAX_EDGE } from "@bulletin/domain/attachments";
import { processRasterImage } from "@bulletin/domain/attachments/processing";
import { createSafeFetch, type SafeFetch, safeFetchDevAllowlist } from "@bulletin/domain/net";
import { type StorageClient, unfurlImageKey } from "@bulletin/storage";
import type { SQL } from "bun";

const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5_000;
const IMAGE_MAX_REDIRECTS = 2;

export interface UnfurlImageProxy {
  readonly key: string;
  /** The stable local path a preview card may put in `<img src>` (ADR 0019). */
  readonly path: string;
}

function imageFetch(): SafeFetch {
  return createSafeFetch({
    devAllow: safeFetchDevAllowlist(),
    maxBytes: IMAGE_MAX_BYTES,
    timeoutMs: IMAGE_TIMEOUT_MS,
    maxRedirects: IMAGE_MAX_REDIRECTS,
  });
}

async function bytesOf(response: Response): Promise<Uint8Array | null> {
  try {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Fetches a preview image through the SSRF-safe client, re-encodes it with the attachment
 * pipeline (stripping metadata), and stores it under `unfurl/<sha256>`. Failures return null:
 * a preview card without its image is still useful, so a broken proxy never fails the unfurl.
 */
export async function proxyUnfurlImage(
  storage: StorageClient,
  imageUrl: string,
  options: { readonly fetch?: SafeFetch } = {},
): Promise<UnfurlImageProxy | null> {
  try {
    const response = await (options.fetch ?? imageFetch())(imageUrl, {
      headers: { accept: "image/*", "user-agent": "BulletinUnfurl/1.0" },
    });

    if (!response.ok) {
      return null;
    }

    const bytes = await bytesOf(response);

    if (bytes === null) {
      return null;
    }

    const processed = await processRasterImage(bytes, { maxEdge: UNFURL_IMAGE_MAX_EDGE });
    const hash = sha256Hex(processed.bytes);
    const key = unfurlImageKey(hash);

    await storage.put(key, processed.bytes, { contentType: processed.contentType });

    return { key, path: `/unfurl/${hash}` };
  } catch {
    return null;
  }
}

/**
 * Live `unfurl/` keys referenced by cached previews; the reconciliation sweep keeps only
 * these and removes images a refresh replaced.
 */
export async function listUnfurlImageKeys(sql: SQL): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT preview->>'imageProxy' AS image_proxy
    FROM core.unfurls
    WHERE preview IS NOT NULL
  `) as Array<{ image_proxy: string | null }>;

  return rows.flatMap((row) => {
    if (row.image_proxy === null) {
      return [];
    }

    const match = /^\/unfurl\/([0-9a-f]{64})$/.exec(row.image_proxy);
    return match?.[1] === undefined ? [] : [`unfurl/${match[1]}`];
  });
}
