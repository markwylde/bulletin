/**
 * VAPID configuration for Web Push (ADR 0014). Development defaults keep `docker compose up`
 * a two-step flow; production must provide its own keys and subject.
 */

export interface VapidConfig {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Development-only key pair. Never used when `NODE_ENV=production`. */
export const DEVELOPMENT_VAPID = {
  publicKey:
    "BBCFIPavSxw0fvQnQWVnBcWOQYpNoVY3HTV-DQwfxTxgYKD2WJUfa0oIATtDitkqO4wQiEAkbjDNnenqfEM0q6c",
  privateKey: "0542K7fgKdTPUVQ1K_r2ZDyaHxXxp3Z7FGea83z5WZ0",
  subject: "mailto:admin@bulletin.localhost",
} as const;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function invalid(message: string): Error {
  return new Error(`Invalid VAPID configuration: ${message}`);
}

function subjectOf(value: string | undefined): string {
  const subject = value?.trim() ?? "";

  if (subject === "") {
    return DEVELOPMENT_VAPID.subject;
  }

  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw invalid("BULLETIN_VAPID_SUBJECT must be a mailto: or https:// URL");
  }

  return subject;
}

/** Reads the VAPID keys from the environment, rejecting the dev pair in production. */
export function loadVapidConfig(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  nodeEnv: "development" | "test" | "production" = env.NODE_ENV === "production"
    ? "production"
    : "development",
): VapidConfig {
  const publicKey = env.BULLETIN_VAPID_PUBLIC_KEY?.trim() || DEVELOPMENT_VAPID.publicKey;
  const privateKey = env.BULLETIN_VAPID_PRIVATE_KEY?.trim() || DEVELOPMENT_VAPID.privateKey;

  if (!BASE64URL.test(publicKey) || publicKey.length < 80 || publicKey.length > 100) {
    throw invalid("BULLETIN_VAPID_PUBLIC_KEY must be a base64url P-256 public key");
  }

  if (!BASE64URL.test(privateKey) || privateKey.length < 40 || privateKey.length > 60) {
    throw invalid("BULLETIN_VAPID_PRIVATE_KEY must be a base64url P-256 private key");
  }

  if (nodeEnv === "production") {
    if (publicKey === DEVELOPMENT_VAPID.publicKey || privateKey === DEVELOPMENT_VAPID.privateKey) {
      throw invalid("the development VAPID keys are not allowed in production");
    }
  }

  return { subject: subjectOf(env.BULLETIN_VAPID_SUBJECT), publicKey, privateKey };
}
