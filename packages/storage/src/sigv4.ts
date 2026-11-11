/**
 * Minimal AWS Signature Version 4 signing for the two S3 operations Bun.S3Client does not
 * expose: `CopyObject` (the server-side snapshot, ADR 0019) and a presigned PUT that signs
 * `content-length` so the exact declared size is enforced at the bucket.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export interface PresignUrlOptions {
  readonly method: "PUT" | "GET";
  readonly url: URL;
  readonly credentials: SigningCredentials;
  readonly expiresIn: number;
  /** Extra headers whose values are part of the signature, e.g. `content-length`. */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  readonly now?: Date;
}

function sha256Hex(value: string): string {
  return Bun.CryptoHasher.hash("sha256", value).toString("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return new Bun.CryptoHasher("sha256", key).update(value).digest();
}

function signingKey(credentials: SigningCredentials, dateStamp: string): Buffer {
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, credentials.region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }

      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): {
  readonly text: string;
  readonly names: string;
} {
  const normalized = new Map<string, string>();

  for (const [name, value] of Object.entries(headers)) {
    normalized.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
  }

  const names = [...normalized.keys()].sort();

  return {
    text: names.map((name) => `${name}:${normalized.get(name) ?? ""}\n`).join(""),
    names: names.join(";"),
  };
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function signature(
  credentials: SigningCredentials,
  dateStamp: string,
  stringToSign: string,
): string {
  return hmac(signingKey(credentials, dateStamp), stringToSign).toString("hex");
}

function credentialScope(credentials: SigningCredentials, dateStamp: string): string {
  return `${dateStamp}/${credentials.region}/${SERVICE}/aws4_request`;
}

/**
 * Signs a header-authenticated request. Returns the headers to send, including
 * `authorization`; `host` stays implicit in the request.
 */
export function signRequestHeaders(input: {
  readonly method: string;
  readonly url: URL;
  readonly credentials: SigningCredentials;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadHash?: string;
  readonly now?: Date;
}): Record<string, string> {
  const date = input.now ?? new Date();
  const stamp = amzDate(date);
  const dateStamp = stamp.slice(0, 8);
  const payloadHash = input.payloadHash ?? UNSIGNED_PAYLOAD;
  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
    ...input.headers,
  };
  const canonical = canonicalHeaders(headers);
  const request = [
    input.method,
    input.url.pathname || "/",
    "",
    canonical.text,
    canonical.names,
    payloadHash,
  ].join("\n");
  const scope = credentialScope(input.credentials, dateStamp);
  const signed = signature(
    input.credentials,
    dateStamp,
    [ALGORITHM, stamp, scope, sha256Hex(request)].join("\n"),
  );

  const result: Record<string, string> = {
    authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${canonical.names}, Signature=${signed}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": stamp,
  };

  for (const [name, value] of Object.entries(headers)) {
    if (name !== "host") {
      result[name] = value;
    }
  }

  return result;
}

/** Builds a presigned URL whose signed headers must be sent unchanged by the client. */
export function presignUrl(options: PresignUrlOptions): string {
  const date = options.now ?? new Date();
  const stamp = amzDate(date);
  const dateStamp = stamp.slice(0, 8);
  const headers: Record<string, string> = {
    host: options.url.host,
    ...options.signedHeaders,
  };
  const canonical = canonicalHeaders(headers);
  const scope = credentialScope(options.credentials, dateStamp);
  const query = canonicalQuery([
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${options.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(options.expiresIn)],
    ["X-Amz-SignedHeaders", canonical.names],
  ]);
  const request = [
    options.method,
    options.url.pathname || "/",
    query,
    canonical.text,
    canonical.names,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const signed = signature(
    options.credentials,
    dateStamp,
    [ALGORITHM, stamp, scope, sha256Hex(request)].join("\n"),
  );

  return `${options.url.origin}${options.url.pathname}?${query}&X-Amz-Signature=${signed}`;
}
