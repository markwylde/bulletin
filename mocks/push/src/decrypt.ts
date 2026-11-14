import { createDecipheriv, createECDH, createHmac } from "node:crypto";

/** Fixed test subscription keys; tests use this public key for the saved device. */
export const PUSH_TEST_KEYS = {
  publicKey:
    "BIoMX_sxHUuVgqtbRjUPQBmOJgqJL1azm_DDUuGNia78sRv4-2LFBClJjN0H-3zsedfsUGONe8p4E52YdSNf3Og",
  privateKey: "vXUjXQOWq_uw7_i8JUkguRNVjxy2exJgZfTwgOE6M5c",
  auth: "QzIEZZnroZ1M_sdeIc8vqA",
} as const;

const INFO = Buffer.from("WebPush: info\0", "utf8");
const AES_128_GCM = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "utf8");

function hmac(key: Buffer, value: Buffer): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/** HKDF-Expand (RFC 5869); the extract step is the HMAC call at each use site. */
function expand(
  prk: Buffer<ArrayBufferLike>,
  info: Buffer<ArrayBufferLike>,
  length: number,
): Buffer<ArrayBufferLike> {
  const parts: Buffer<ArrayBufferLike>[] = [];
  let previous: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  for (let index = 1; Buffer.concat(parts).length < length; index += 1) {
    previous = hmac(prk, Buffer.concat([previous, info, Buffer.from([index])]));
    parts.push(previous);
  }

  return Buffer.concat(parts).subarray(0, length);
}

function base64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export interface DecryptedPush {
  readonly payload: string;
  readonly senderPublicKey: string;
}

/**
 * Decrypts an aes128gcm Web Push body (RFC 8291) with the mock's fixed test subscription key.
 * The push service itself never decrypts in production; the mock owns the test private key so
 * developers can inspect what the worker actually sent.
 */
export function decryptPushBody(
  body: Buffer,
  privateKey: string = PUSH_TEST_KEYS.privateKey,
  receiverPublicKey: string = PUSH_TEST_KEYS.publicKey,
  authSecret: string = PUSH_TEST_KEYS.auth,
): DecryptedPush {
  if (body.byteLength < 16 + 4 + 1 + 16) {
    throw new Error("Push body is too short");
  }

  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const senderStart = 21;
  const senderEnd = senderStart + idLength;

  if (idLength < 16 || body.byteLength <= senderEnd + 16) {
    throw new Error("Push body has an invalid key id");
  }

  const senderPublic = body.subarray(senderStart, senderEnd);
  const ciphertext = body.subarray(senderEnd);
  const receiverPublic = base64url(receiverPublicKey);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(base64url(privateKey));
  const sharedSecret = ecdh.computeSecret(senderPublic);
  const prk = hmac(base64url(authSecret), sharedSecret);
  const keyInfo = Buffer.concat([INFO, receiverPublic, senderPublic]);
  const ikm = expand(prk, keyInfo, 32);
  const cek = expand(hmac(salt, ikm), AES_128_GCM, 16);
  const nonce = expand(hmac(salt, ikm), NONCE_INFO, 12);
  const tag = ciphertext.subarray(ciphertext.byteLength - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.byteLength - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const delimiter = plaintext.lastIndexOf(0x02);

  if (delimiter < 0) {
    throw new Error("Push payload has no padding delimiter");
  }

  return {
    payload: plaintext.subarray(0, delimiter).toString("utf8"),
    senderPublicKey: senderPublic.toString("base64url"),
  };
}
