import { presignUrl, type SigningCredentials, signRequestHeaders } from "./sigv4.ts";

export const PRESIGN_PUT_EXPIRES_IN = 300;
export const PRESIGN_GET_EXPIRES_IN = 60;

export interface StorageConfig {
  readonly endpoint: string;
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

export interface StorageClient {
  put(key: string, data: Uint8Array | string, options?: PutOptions): Promise<number>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<ObjectStat>;
  delete(key: string): Promise<void>;
  /** Server-side `CopyObject`; the bytes never pass through the caller. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  list(prefix: string): Promise<readonly StoredObjectSummary[]>;
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

function objectUrl(config: StorageConfig, key: string): URL {
  const base = config.endpoint.replace(/\/+$/, "");
  return new URL(`${base}/${encodeURIComponent(config.bucket)}/${encodeKeyPath(key)}`);
}

function credentialsOf(config: StorageConfig): SigningCredentials {
  return {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region ?? "us-east-1",
  };
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

  return {
    async put(key, data, options = {}) {
      return client.write(key, data, {
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
      return client.presign(key, {
        method: "GET",
        expiresIn: options.expiresIn ?? PRESIGN_GET_EXPIRES_IN,
        ...(options.responseContentType === undefined ? {} : { type: options.responseContentType }),
        ...(options.responseContentDisposition === undefined
          ? {}
          : { contentDisposition: options.responseContentDisposition }),
      });
    },

    presignPut(key, options = {}) {
      // Bun's presign cannot include `content-length` in SignedHeaders, and the upload
      // contract needs the exact declared size enforced by the bucket (ADR 0019).
      return presignUrl({
        method: "PUT",
        url: objectUrl(config, key),
        credentials,
        expiresIn: options.expiresIn ?? PRESIGN_PUT_EXPIRES_IN,
        ...(options.contentLength === undefined
          ? {}
          : { signedHeaders: { "content-length": String(options.contentLength) } }),
      });
    },
  };
}
