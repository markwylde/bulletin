import { ConfigError, type NodeEnv } from "./env.ts";

export interface StorageEnvironment {
  readonly endpoint: string;
  /** Public origin used in presigned URLs (the files origin); defaults to `endpoint`. */
  readonly publicEndpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

const DEV_DEFAULTS = {
  endpoint: "http://localhost:4001/_mocks/s3",
  bucket: "bulletin",
  accessKeyId: "bulletin",
  secretAccessKey: "bulletin-secret",
  region: "us-east-1",
} as const;

function value(
  env: Readonly<Record<string, string | undefined>>,
  key: keyof typeof DEV_DEFAULTS,
  envKey: string,
  issues: string[],
  nodeEnv: NodeEnv,
): string {
  const raw = env[envKey]?.trim();

  if (raw !== undefined && raw !== "") {
    return raw;
  }

  if (nodeEnv === "production") {
    issues.push(`${envKey} must be set in production`);
  }

  return DEV_DEFAULTS[key];
}

/** Storage credentials for the local S3 mock, rejected when production forgets to set them. */
export function loadStorageEnvironment(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  nodeEnv: NodeEnv = env.NODE_ENV === "production" ? "production" : "development",
): StorageEnvironment {
  const issues: string[] = [];
  const endpoint = value(env, "endpoint", "S3_ENDPOINT", issues, nodeEnv);
  const storage: StorageEnvironment = {
    endpoint,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT?.trim() || endpoint,
    bucket: value(env, "bucket", "S3_BUCKET", issues, nodeEnv),
    accessKeyId: value(env, "accessKeyId", "S3_ACCESS_KEY_ID", issues, nodeEnv),
    secretAccessKey: value(env, "secretAccessKey", "S3_SECRET_ACCESS_KEY", issues, nodeEnv),
    region: value(env, "region", "S3_REGION", issues, nodeEnv),
  };

  for (const [key, envKey] of [
    ["endpoint", "S3_ENDPOINT"],
    ["publicEndpoint", "S3_PUBLIC_ENDPOINT"],
  ] as const) {
    try {
      new URL(storage[key]);
    } catch {
      issues.push(`${envKey} must be an absolute URL`);
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return storage;
}
