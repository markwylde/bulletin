import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000;

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export type SignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface CredentialScope {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
  readonly terminator: string;
}

const UNSIGNED = { ok: false, reason: "Missing authentication" } as const;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(url: URL, excludeSignature: boolean): string {
  const pairs = [...url.searchParams.entries()]
    .filter(([key]) => !(excludeSignature && key === "X-Amz-Signature"))
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey !== rightKey) {
        return leftKey < rightKey ? -1 : 1;
      }

      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    });

  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

function canonicalHeaders(headers: Headers, signedHeaders: readonly string[]): string {
  return [...signedHeaders]
    .sort()
    .map((name) => {
      const value = headers.get(name) ?? "";
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
}

function parseCredential(value: string): CredentialScope | null {
  const [accessKeyId, date, region, service, terminator] = value.split("/");

  if (
    accessKeyId === undefined ||
    date === undefined ||
    region === undefined ||
    service === undefined ||
    terminator !== "aws4_request"
  ) {
    return null;
  }

  return { accessKeyId, date, region, service, terminator };
}

function sameSignature(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");

  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function checkScope(scope: CredentialScope, credentials: S3Credentials): SignatureResult | null {
  if (scope.accessKeyId !== credentials.accessKeyId) {
    return { ok: false, reason: "Unknown access key" };
  }

  if (scope.region !== credentials.region || scope.service !== SERVICE) {
    return { ok: false, reason: "Credential scope mismatch" };
  }

  return null;
}

/**
 * Verifies both SigV4 Authorization headers (used by Bun.S3Client) and presigned URLs
 * (`X-Amz-Signature` query parameters) used by browsers and integrations.
 */
export function verifyRequestSignature(
  request: Request,
  url: URL,
  credentials: S3Credentials,
  now = new Date(),
  body?: Uint8Array,
): SignatureResult {
  const presignedSignature = url.searchParams.get("X-Amz-Signature");
  const authorization = request.headers.get("authorization");

  if (presignedSignature === null && authorization === null) {
    return UNSIGNED;
  }

  let credentialScope: CredentialScope | null;
  let signedHeaders: string[];
  let signature: string;
  let amzDate: string;
  let payloadHash: string;
  let expires: number | null = null;

  if (presignedSignature !== null) {
    if (url.searchParams.get("X-Amz-Algorithm") !== ALGORITHM) {
      return { ok: false, reason: "Unsupported signature algorithm" };
    }

    credentialScope = parseCredential(url.searchParams.get("X-Amz-Credential") ?? "");
    signedHeaders = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean);
    signature = presignedSignature;
    amzDate = url.searchParams.get("X-Amz-Date") ?? "";
    payloadHash = url.searchParams.get("X-Amz-Content-Sha256") ?? UNSIGNED_PAYLOAD;
    expires = Number(url.searchParams.get("X-Amz-Expires") ?? "0");
  } else {
    const match = /^AWS4-HMAC-SHA256 (.*)$/.exec(authorization ?? "");
    const fields = new Map(
      (match?.[1] ?? "").split(",").map((part) => {
        const [key, ...value] = part.trim().split("=");
        return [key ?? "", value.join("=")] as const;
      }),
    );

    credentialScope = parseCredential(fields.get("Credential") ?? "");
    signedHeaders = (fields.get("SignedHeaders") ?? "").split(";").filter(Boolean);
    signature = fields.get("Signature") ?? "";
    amzDate = request.headers.get("x-amz-date") ?? "";
    payloadHash = request.headers.get("x-amz-content-sha256") ?? UNSIGNED_PAYLOAD;
  }

  if (credentialScope === null) {
    return { ok: false, reason: "Malformed credential" };
  }

  const scopeError = checkScope(credentialScope, credentials);
  if (scopeError !== null) {
    return scopeError;
  }

  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) {
    return { ok: false, reason: "Missing or invalid X-Amz-Date" };
  }

  const requestDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(
      9,
      11,
    )}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );

  if (Number.isNaN(requestDate.getTime())) {
    return { ok: false, reason: "Invalid X-Amz-Date" };
  }

  if (requestDate.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "Request date is in the future" };
  }

  if (presignedSignature === null && requestDate.getTime() < now.getTime() - MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: "Request signature expired" };
  }

  if (expires !== null) {
    if (!Number.isFinite(expires) || expires <= 0 || expires > 604_800) {
      return { ok: false, reason: "Invalid X-Amz-Expires" };
    }

    if (requestDate.getTime() + expires * 1000 < now.getTime()) {
      return { ok: false, reason: "Presigned URL expired" };
    }
  }

  const canonical = [
    request.method,
    url.pathname || "/",
    canonicalQuery(url, presignedSignature !== null),
    canonicalHeaders(request.headers, signedHeaders) || "\n",
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${credentialScope.date}/${credentialScope.region}/${credentialScope.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  const expected = createHmac(
    "sha256",
    signingKey(credentials.secretAccessKey, credentialScope.date, credentialScope.region, SERVICE),
  )
    .update(stringToSign)
    .digest("hex");

  if (!sameSignature(expected, signature)) {
    return { ok: false, reason: "Signature mismatch" };
  }

  if (payloadHash !== UNSIGNED_PAYLOAD) {
    if (!/^[0-9a-f]{64}$/i.test(payloadHash)) {
      return { ok: false, reason: "Unsupported payload hash" };
    }

    const actualHash = createHash("sha256")
      .update(body ?? new Uint8Array())
      .digest("hex");

    if (!sameSignature(actualHash, payloadHash.toLowerCase())) {
      return { ok: false, reason: "Payload hash mismatch" };
    }
  }

  return { ok: true };
}

/** Test helper: signs a concrete-payload request exactly as the mock verifier expects. */
export function signRequestHeaders(input: {
  readonly method: string;
  readonly url: URL;
  readonly body: Uint8Array;
  readonly credentials: S3Credentials;
  readonly date?: Date;
}): Record<string, string> {
  const date = input.date ?? new Date();
  const amzDate = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(input.body).digest("hex");
  const host = input.url.host;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const canonical = [
    input.method,
    input.url.pathname || "/",
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.credentials.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(input.credentials.secretAccessKey, dateStamp, input.credentials.region, SERVICE),
  )
    .update(stringToSign)
    .digest("hex");

  return {
    authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
}
