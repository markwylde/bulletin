import { ConfigError, type NodeEnv } from "./env.ts";

export interface StorageEnvironment {
  readonly endpoint: string;
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
  const storage: StorageEnvironment = {
    endpoint: value(env, "endpoint", "S3_ENDPOINT", issues, nodeEnv),
    bucket: value(env, "bucket", "S3_BUCKET", issues, nodeEnv),
    accessKeyId: value(env, "accessKeyId", "S3_ACCESS_KEY_ID", issues, nodeEnv),
    secretAccessKey: value(env, "secretAccessKey", "S3_SECRET_ACCESS_KEY", issues, nodeEnv),
    region: value(env, "region", "S3_REGION", issues, nodeEnv),
  };

  try {
    new URL(storage.endpoint);
  } catch {
    issues.push("S3_ENDPOINT must be an absolute URL");
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return storage;
}
