export const KEY_PREFIXES = ["att", "av", "theme", "plugin", "export", "emoticon"] as const;
export type KeyPrefix = (typeof KEY_PREFIXES)[number];

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
  readonly expiresIn?: number;
  readonly contentType?: string;
}

export interface PresignGetOptions {
  readonly expiresIn?: number;
}

export interface StorageClient {
  put(key: string, data: Uint8Array | string, options?: PutOptions): Promise<number>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  presignGet(key: string, options?: PresignGetOptions): string;
  presignPut(key: string, options?: PresignPutOptions): string;
}

/** Opaque, non-guessable keys; metadata in the database is authoritative (ADR 0019). */
export function opaqueKey(prefix: KeyPrefix = "att", id: string = crypto.randomUUID()): string {
  return `${prefix}/${id}`;
}

export function createStorage(config: StorageConfig): StorageClient {
  const client = new Bun.S3Client({
    endpoint: config.endpoint,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.region === undefined ? {} : { region: config.region }),
  });

  return {
    async put(key, data, options = {}) {
      return client.write(key, data, {
        ...(options.contentType === undefined ? {} : { type: options.contentType }),
      });
    },

    async get(key) {
      return client.file(key).bytes();
    },

    async delete(key) {
      await client.delete(key);
    },

    presignGet(key, options = {}) {
      return client.presign(key, {
        ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
      });
    },

    presignPut(key, options = {}) {
      return client.presign(key, {
        method: "PUT",
        ...(options.expiresIn === undefined ? {} : { expiresIn: options.expiresIn }),
        ...(options.contentType === undefined ? {} : { type: options.contentType }),
      });
    },
  };
}
