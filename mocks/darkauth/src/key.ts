import { mkdir } from "node:fs/promises";
import { type CryptoKey, exportJWK, generateKeyPair, importJWK, type JWK } from "jose";

export interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

const KEY_FILE = "darkauth-key.json";

export async function loadSigningKey(dataDir: string): Promise<SigningKey> {
  const path = `${dataDir}/${KEY_FILE}`;

  try {
    const stored = JSON.parse(await Bun.file(path).text()) as {
      kid?: string;
      privateJwk?: JWK;
      publicJwk?: JWK;
    };

    if (
      stored.kid !== undefined &&
      stored.privateJwk !== undefined &&
      stored.publicJwk !== undefined
    ) {
      const privateKey = (await importJWK(stored.privateJwk, "EdDSA")) as CryptoKey;
      return { kid: stored.kid, privateKey, publicJwk: stored.publicJwk };
    }
  } catch {
    // First start, or an unreadable key file: generate a fresh key below.
  }

  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  const key: SigningKey = { kid: "bulletin-mock", privateKey: pair.privateKey, publicJwk };

  try {
    await mkdir(dataDir, { recursive: true });
    await Bun.write(path, JSON.stringify({ kid: key.kid, privateJwk, publicJwk }));
  } catch {
    // A read-only filesystem is acceptable: tokens stay valid for this process's lifetime.
  }

  return key;
}
