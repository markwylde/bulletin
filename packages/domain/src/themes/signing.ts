import { createPrivateKey, createPublicKey, type JsonWebKeyInput, sign, verify } from "node:crypto";
import type { JWK } from "jose";

/** Development-only Ed25519 key shared by the marketplace mock and local exports. */
export const DEV_THEME_PRIVATE_KEY: JWK = {
  kty: "OKP",
  crv: "Ed25519",
  d: "rjnGhDeB5NqL3_u5azgREbET9oTaPlBp5Le0wsSlsSg",
  x: "ygRyiCz07UHHzPvkEWojXUk1Pxuc6vrMD1Y-cszvoH0",
  kid: "bulletin-theme-dev",
  alg: "EdDSA",
  use: "sig",
};

export const DEV_THEME_PUBLIC_KEY: JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "ygRyiCz07UHHzPvkEWojXUk1Pxuc6vrMD1Y-cszvoH0",
  kid: "bulletin-theme-dev",
  alg: "EdDSA",
  use: "sig",
};

function privateKey(jwk: JWK) {
  return createPrivateKey({ key: jwk, format: "jwk" } as JsonWebKeyInput);
}

function publicKey(jwk: JWK) {
  return createPublicKey({ key: jwk, format: "jwk" } as JsonWebKeyInput);
}

/** Detached Ed25519 signature (base64url) over the exact bundle bytes. */
export function signThemeBundle(bundle: Uint8Array, key: JWK): string {
  return sign(null, bundle, privateKey(key)).toString("base64url");
}

/** True only for the configured key and the exact bytes; malformed input fails closed. */
export function verifyThemeBundle(bundle: Uint8Array, signature: string, key: JWK): boolean {
  if (signature.length === 0 || signature.length > 200) {
    return false;
  }

  let bytes: Buffer;

  try {
    bytes = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }

  try {
    return verify(null, bundle, publicKey(key), bytes);
  } catch {
    return false;
  }
}

export function parseJwk(value: string): JWK | null {
  try {
    const parsed: unknown = JSON.parse(value);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { kty?: unknown }).kty === "OKP" &&
      (parsed as { crv?: unknown }).crv === "Ed25519"
    ) {
      return parsed as JWK;
    }
  } catch {
    return null;
  }

  return null;
}
