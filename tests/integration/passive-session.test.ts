import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  demoThemesSeedModule,
  forumSeedModule,
  groupsSeedModule,
  membersSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  type AuthService,
  createAuthService,
  hashToken,
  REAUTH_GRACE_MS,
  sessionCookieName,
} from "@bulletin/domain/auth";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import { passiveThemeOptionsResponse } from "../../apps/user-api/src/appearance.ts";

// AuthService.passiveSession and the footer theme chooser's read (ADR 0018, 0021): a session
// waiting for silent re-auth reads as a guest, so background requests never answer 401, and
// it never sees member-restricted themes until the session is renewed.

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const COOKIE = sessionCookieName("user", "test");

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "passive_session" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        forumSeedModule,
        groupsSeedModule,
        themesSeedModule,
        demoThemesSeedModule,
        membersSeedModule,
      ]),
    });
    await run(database);
  });
}

async function withAuth(
  database: TestDatabase,
  run: (auth: AuthService) => Promise<void>,
): Promise<void> {
  const url = new URL(database.url);
  url.username = "user_api";
  url.password = "";
  const sql = new SQL(url.toString());
  const auth = await createAuthService({
    sql,
    kind: "user",
    issuer: authIssuer(),
    jwksUrl: "http://127.0.0.1:1/jwks.json",
    clientId: "bulletin-user",
    origin: userOrigin(),
    sessionSecret: "test-session-secret",
    nodeEnv: "test",
    cacheTtlMs: 0,
  });

  try {
    await run(auth);
  } finally {
    await auth.close();
    await sql.close();
  }
}

async function memberId(database: TestDatabase): Promise<string> {
  const [member] = (await database.sql`
    SELECT member_id::text AS id FROM pii.identities WHERE sub = 'member-1'
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Missing member-1");
  }

  return member.id;
}

/** Inserts a session whose re-auth deadline is `reauthOffsetMs` from now; returns the cookie. */
async function sessionCookie(
  database: TestDatabase,
  member: string,
  reauthOffsetMs: number,
  revoked = false,
): Promise<string> {
  const token = crypto.randomUUID();
  const reauthAt = new Date(Date.now() + reauthOffsetMs);
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at, revoked_at)
    VALUES (
      ${member}, 'user', ${hashToken(token)}, ${reauthAt}, now(),
      ${revoked ? new Date() : null}
    )
  `;
  return `${COOKIE}=${token}`;
}

function request(cookie?: string): Request {
  return new Request(`${userOrigin()}/api/theme-options`, {
    headers: cookie === undefined ? {} : { cookie },
  });
}

const EXPIRED = -(REAUTH_GRACE_MS + 60_000);
const LIVE = 12 * 60 * 60 * 1_000;

integrationDescribe("passive session lookup", () => {
  test("returns a live session and null for expired, revoked, unknown or missing cookies", async () => {
    await withDb(async (database) => {
      const member = await memberId(database);

      await withAuth(database, async (auth) => {
        const live = await auth.passiveSession(
          request(await sessionCookie(database, member, LIVE)),
        );
        expect(live?.memberId).toBe(member);

        // Inside the grace window the session is still live.
        const grace = await auth.passiveSession(
          request(await sessionCookie(database, member, -60_000)),
        );
        expect(grace?.memberId).toBe(member);

        expect(
          await auth.passiveSession(request(await sessionCookie(database, member, EXPIRED))),
        ).toBeNull();
        expect(
          await auth.passiveSession(request(await sessionCookie(database, member, LIVE, true))),
        ).toBeNull();
        expect(await auth.passiveSession(request(`${COOKIE}=${crypto.randomUUID()}`))).toBeNull();
        expect(await auth.passiveSession(request())).toBeNull();
      });
    });
  }, 60_000);

  test("theme options answer an expired-reauth cookie with the guest list, never restricted themes", async () => {
    await withDb(async (database) => {
      const member = await memberId(database);
      // Give member-1 every group the restricted theme allows, so only the session decides.
      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id)
        SELECT ${member}, tag.group_id
        FROM core.theme_allowed_groups tag
        JOIN core.themes t ON t.id = tag.theme_id
        WHERE t.name = 'vip-gold'
        ON CONFLICT DO NOTHING
      `;

      await withAuth(database, async (auth) => {
        const names = async (cookie?: string) => {
          const response = await passiveThemeOptionsResponse(database.sql, auth, request(cookie));
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            member: boolean;
            themes: { name: string }[];
          };
          return { member: body.member, names: body.themes.map((theme) => theme.name).sort() };
        };

        const guest = await names();
        const live = await names(await sessionCookie(database, member, LIVE));
        const expired = await names(await sessionCookie(database, member, EXPIRED));

        expect(guest.member).toBe(false);
        expect(guest.names).not.toContain("vip-gold");
        expect(live.member).toBe(true);
        expect(live.names).toContain("vip-gold");
        expect(expired).toEqual(guest);
      });
    });
  }, 60_000);
});
