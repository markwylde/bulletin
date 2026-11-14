import { presignUrl, type SigningCredentials, signRequestHeaders } from "./sigv4.ts";

export const PRESIGN_PUT_EXPIRES_IN = 300;
export const PRESIGN_GET_EXPIRES_IN = 60;

export interface StorageConfig {
  /** Internal endpoint used for object operations (put/get/copy/list). */
  readonly endpoint: string;
  /** Public origin baked into presigned URLs; defaults to `endpoint`. */
  readonly publicEndpoint?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region?: string;
}

export interface PutOptions {
  readonly contentType?: string;
}

export interface PresignPutOptions {
  /** Exact `Content-Length` the client must upload; a different size fails the signature. */
  readonly contentLength?: number;
  readonly expiresIn?: number;
}

export interface PresignGetOptions {
  readonly expiresIn?: number;
  /** Overrides the stored type on the response, set from the verified type (ADR 0019). */
  readonly responseContentType?: string;
  /** `inline` for allowlisted raster images, `attachment` for everything else. */
  readonly responseContentDisposition?: string;
}

export interface ObjectStat {
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
}

export interface StoredObjectSummary {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

/** One version of an object in a versioned bucket (ADR 0020: 35-day noncurrent expiry). */
export interface ObjectVersionSummary {
  readonly key: string;
  readonly versionId: string;
  readonly isLatest: boolean;
  /** A delete marker: the key was deleted at `lastModified`; older versions remain. */
  readonly deleteMarker: boolean;
  readonly size: number;
  readonly lastModified: Date;
}

export interface StorageClient {
  put(key: string, data: Uint8Array | string, options?: PutOptions): Promise<number>;
  /** Streams a file from disk to the bucket without loading it into the caller's memory. */
  putFile?(key: string, path: string, options?: PutOptions): Promise<number>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<ObjectStat>;
  delete(key: string): Promise<void>;
  /** Server-side `CopyObject`; the bytes never pass through the caller. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  list(prefix: string): Promise<readonly StoredObjectSummary[]>;
  /** `ListObjectVersions`, newest first per key. */
  listVersions?(prefix: string): Promise<readonly ObjectVersionSummary[]>;
  /** Makes a previous version current again with a server-side copy onto the same key. */
  restoreVersion?(key: string, versionId: string): Promise<void>;
  presignGet(key: string, options?: PresignGetOptions): string;
  presignPut(key: string, options?: PresignPutOptions): string;
}

/** Percent-encodes each key segment while keeping the `/` separators. */
function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function objectUrl(config: StorageConfig, key: string, endpoint = config.endpoint): URL {
  const base = endpoint.replace(/\/+$/, "");
  return new URL(`${base}/${encodeURIComponent(config.bucket)}/${encodeKeyPath(key)}`);
}

function credentialsOf(config: StorageConfig): SigningCredentials {
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region ?? "us-east-1",
  };
}

function xmlText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return (match?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

/** Parses a `ListVersionsResult` document (versions and delete markers). */
export function parseVersionsXml(xml: string): ObjectVersionSummary[] {
  const versions: ObjectVersionSummary[] = [];

  for (const match of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const block = match[2] ?? "";
    versions.push({
      key: xmlText(block, "Key"),
      versionId: xmlText(block, "VersionId"),
      isLatest: xmlText(block, "IsLatest") === "true",
      deleteMarker: match[1] === "DeleteMarker",
      size: Number(xmlText(block, "Size") || "0"),
      lastModified: new Date(xmlText(block, "LastModified")),
    });
  }

  return versions;
}

export function createStorage(config: StorageConfig): StorageClient {
  const client = new Bun.S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.region === undefined ? {} : { region: config.region }),
  });
  const credentials = credentialsOf(config);
  const publicEndpoint = config.publicEndpoint ?? config.endpoint;

  return {
    async put(key, data, options = {}) {
      return client.write(key, data, {
        ...(options.contentType === undefined ? {} : { type: options.contentType }),
      });
    },

    async putFile(key, path, options = {}) {
      return client.write(key, Bun.file(path), {
        ...(options.contentType === undefined ? {} : { type: options.contentType }),
      });
    },

    async get(key) {
      return client.file(key).bytes();
    },

    async exists(key) {
      return client.exists(key);
    },

    async stat(key) {
      const stat = await client.stat(key);
      return { size: stat.size, contentType: stat.type, etag: stat.etag };
    },

    async delete(key) {
      await client.delete(key);
    },

    async copy(sourceKey, destinationKey) {
      // COPY is a PUT with `x-amz-copy-source` and no body; Bun.S3Client has no copy method.
      const headers = signRequestHeaders({
        method: "PUT",
        url: objectUrl(config, destinationKey),
        credentials,
        headers: { "x-amz-copy-source": `/${config.bucket}/${encodeKeyPath(sourceKey)}` },
        // SHA-256 of the empty body, so the copy works against plain-HTTP endpoints too.
        payloadHash: Bun.CryptoHasher.hash("sha256", "").toString("hex"),
      });
      const response = await fetch(objectUrl(config, destinationKey), {
        method: "PUT",
        headers,
      });

      if (!response.ok) {
        throw new Error(`CopyObject ${sourceKey} -> ${destinationKey} failed: ${response.status}`);
      }
    },

    async listVersions(prefix) {
      const url = new URL(
        `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`,
      );
      url.searchParams.set("versions", "");
      url.searchParams.set("prefix", prefix);
      const response = await fetch(url, {
        headers: signRequestHeaders({ method: "GET", url, credentials }),
      });

      if (!response.ok) {
        throw new Error(`ListObjectVersions ${prefix} failed: ${response.status}`);
      }

      return parseVersionsXml(await response.text());
    },

    async restoreVersion(key, versionId) {
      const headers = signRequestHeaders({
        method: "PUT",
        url: objectUrl(config, key),
        credentials,
        headers: {
          "x-amz-copy-source": `/${config.bucket}/${encodeKeyPath(key)}?versionId=${encodeURIComponent(versionId)}`,
        },
        payloadHash: Bun.CryptoHasher.hash("sha256", "").toString("hex"),
      });
      const response = await fetch(objectUrl(config, key), { method: "PUT", headers });

      if (!response.ok) {
        throw new Error(`Restoring ${key} version ${versionId} failed: ${response.status}`);
      }
    },

    async list(prefix) {
      const objects: StoredObjectSummary[] = [];
      let continuationToken: string | undefined;

      do {
        const page = await client.list({
          prefix,
          maxKeys: 1000,
          ...(continuationToken === undefined ? {} : { continuationToken }),
        });

        for (const object of page.contents ?? []) {
          objects.push({
            key: object.key,
            size: object.size ?? 0,
            lastModified:
              object.lastModified === undefined ? new Date(0) : new Date(object.lastModified),
          });
        }

        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken !== undefined);

      return objects;
    },

    presignGet(key, options = {}) {
      return presignUrl({
        method: "GET",
        url: objectUrl(config, key, publicEndpoint),
        credentials,
        expiresIn: options.expiresIn ?? PRESIGN_GET_EXPIRES_IN,
        ...(options.responseContentType === undefined
          ? {}
          : { responseContentType: options.responseContentType }),
        ...(options.responseContentDisposition === undefined
          ? {}
          : { responseContentDisposition: options.responseContentDisposition }),
      });
    },

    presignPut(key, options = {}) {
      // Bun's presign cannot include `content-length` in SignedHeaders, and the upload
      // contract needs the exact declared size enforced by the bucket (ADR 0019).
      return presignUrl({
        method: "PUT",
        url: objectUrl(config, key, publicEndpoint),
        credentials,
        expiresIn: options.expiresIn ?? PRESIGN_PUT_EXPIRES_IN,
        ...(options.contentLength === undefined
          ? {}
          : { signedHeaders: { "content-length": String(options.contentLength) } }),
      });
    },
  };
}
