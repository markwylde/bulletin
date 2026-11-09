import type { JWK } from "jose";

export const DEV_KEY_ID = "bulletin-marketplace-dev";

/**
 * Development-only marketplace signing key. It is deliberately committed so every clone
 * produces the same catalogue signature; never use it outside local development.
 */
export const DEV_PRIVATE_KEY: JWK = {
  kty: "OKP",
  crv: "Ed25519",
  d: "rjnGhDeB5NqL3_u5azgREbET9oTaPlBp5Le0wsSlsSg",
  x: "ygRyiCz07UHHzPvkEWojXUk1Pxuc6vrMD1Y-cszvoH0",
  kid: DEV_KEY_ID,
  alg: "EdDSA",
  use: "sig",
};

export const DEV_PUBLIC_KEY: JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "ygRyiCz07UHHzPvkEWojXUk1Pxuc6vrMD1Y-cszvoH0",
  kid: DEV_KEY_ID,
  alg: "EdDSA",
  use: "sig",
};
