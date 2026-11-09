import { beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { authIssuer } from "@bulletin/test-utils/urls";
import { createLocalJWKSet, jwtVerify } from "jose";

// Run against the running compose stack:
//   docker compose up -d
//   bun run test:integration

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const ISSUER = authIssuer();
const USER_CLIENT = "bulletin-user";
const STAFF_CLIENT = "bulletin-staff";

interface Profile {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

interface MockConfig {
  readonly users?: readonly Profile[];
}

interface TokenSet {
  readonly id_token: string;
  readonly access_token: string;
}

const config = Bun.YAML.parse(
  await Bun.file(new URL("../../darkauth-mock.yaml", import.meta.url)).text(),
) as MockConfig;
const profiles = config.users ?? [];

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());

  return { verifier, challenge };
}

async function authorizationCodeFlow(
  profile: Profile,
  clientId: string,
): Promise<{ tokens: TokenSet; nonce: string }> {
  const { verifier, challenge } = createPkce();
  const state = base64Url(randomBytes(16));
  const nonce = base64Url(randomBytes(16));
  const redirectUri = `${ISSUER}/callback`;

  const authorize = await fetch(`${ISSUER}/authorize/continue`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      nonce,
      scope: "openid profile email",
      code_challenge: challenge,
      code_challenge_method: "S256",
      user: profile.sub,
    }),
    redirect: "manual",
  });

  expect(authorize.status).toBe(303);

  const location = authorize.headers.get("location");
  expect(location).toBeString();

  if (location === null) {
    throw new Error("darkauth-mock did not return a callback location");
  }

  const callback = new URL(location);
  expect(callback.searchParams.get("state")).toBe(state);

  const code = callback.searchParams.get("code");
  expect(code).toBeString();

  if (code === null) {
    throw new Error("darkauth-mock did not return an authorization code");
  }

  const tokenResponse = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  expect(tokenResponse.status).toBe(200);

  const tokens = (await tokenResponse.json()) as TokenSet;
  expect(tokens.id_token).toBeString();

  return { tokens, nonce };
}

const integrationDescribe = ENABLED ? describe : describe.skip;

integrationDescribe("darkauth-mock code flow", () => {
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    const response = await fetch(`${ISSUER}/.well-known/jwks.json`);
    expect(response.ok).toBe(true);

    const body = (await response.json()) as Parameters<typeof createLocalJWKSet>[0];
    expect(body.keys.length).toBeGreaterThan(0);
    jwks = createLocalJWKSet(body);
  });

  test("every seeded profile receives an ID token verifiable via JWKS", async () => {
    expect(profiles.length).toBeGreaterThanOrEqual(10);

    for (const profile of profiles) {
      const { tokens, nonce } = await authorizationCodeFlow(profile, USER_CLIENT);

      const { payload, protectedHeader } = await jwtVerify(tokens.id_token, jwks, {
        issuer: ISSUER,
        audience: USER_CLIENT,
        algorithms: ["EdDSA"],
      });

      expect(protectedHeader.alg).toBe("EdDSA");
      expect(payload.iss).toBe(ISSUER);
      expect(payload.aud).toBe(USER_CLIENT);
      expect(payload.sub).toBe(profile.sub);
      expect(payload.email).toBe(profile.email);
      expect(payload.name).toBe(profile.name);
      expect(payload.nonce).toBe(nonce);
      expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  test("the staff client is a separate audience", async () => {
    const profile = profiles[0];

    if (profile === undefined) {
      throw new Error("darkauth-mock.yaml has no profiles");
    }

    const { tokens } = await authorizationCodeFlow(profile, STAFF_CLIENT);

    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer: ISSUER,
      audience: STAFF_CLIENT,
      algorithms: ["EdDSA"],
    });

    expect(payload.aud).toBe(STAFF_CLIENT);
    expect(payload.sub).toBe(profile.sub);
  });
});
