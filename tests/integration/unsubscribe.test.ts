import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import {
  createUnsubscribeToken,
  digestFrequency,
  notificationChannels,
  setDigestFrequency,
} from "@bulletin/domain/notifications";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { userOrigin } from "@bulletin/test-utils/urls";
import { unsubscribeResponse } from "../../apps/user-api/src/unsubscribe.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildUnsubscribePage } from "../../apps/user-app/src/unsubscribe/page.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SECRET = "unsubscribe-test-secret";
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "unsubscribe" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

function tokenFor(
  memberIdValue: string,
  type: "topic.reply" | "digest",
  expiresAt = Date.now() + 60_000,
): string {
  return createUnsubscribeToken(SECRET, { memberId: memberIdValue, type, expiresAt });
}

function formRequest(token: string, options: { readonly origin?: string } = {}): Request {
  return new Request("http://user.test/api/notifications/unsubscribe", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: `token=${encodeURIComponent(token)}`,
  });
}

integrationDescribe("unsubscribe", () => {
  test("the confirmation page renders a form and changes nothing", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const token = tokenFor(member, "topic.reply");
      const page = buildUnsubscribePage({ token, secret: SECRET, translate });

      expect(page.state).toBe("confirm");
      expect(page.showForm).toBe(true);
      expect(page.token).toBe(token);
      expect(page.body).toContain("Replies in followed topics");

      // A mail scanner fetching the link only renders this page: no preference rows change.
      buildUnsubscribePage({ token, secret: SECRET, translate });
      const [row] = (await database.sql`
        SELECT count(*)::int AS count FROM core.notification_preferences
      `) as Array<{ count: number }>;
      expect(row?.count).toBe(0);
      expect(await notificationChannels(database.sql, member, "topic.reply")).toEqual({
        in_app: true,
        email: true,
        digest: false,
      });
    });
  }, 30_000);

  test("an invalid or expired token shows the invalid page", () => {
    const expired = buildUnsubscribePage({
      token: tokenFor("5", "topic.reply", Date.now() - 1),
      secret: SECRET,
      translate,
    });
    expect(expired).toMatchObject({ state: "invalid", showForm: false });

    const tampered = buildUnsubscribePage({
      token: `${tokenFor("5", "topic.reply")}x`,
      secret: SECRET,
      translate,
    });
    expect(tampered.state).toBe("invalid");

    const missing = buildUnsubscribePage({ token: null, secret: SECRET, translate });
    expect(missing.state).toBe("invalid");
  });

  test("confirming disables email for that type without a session", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const token = tokenFor(member, "topic.reply");
      const response = await unsubscribeResponse(
        database.sql,
        { secret: SECRET, userOrigin: userOrigin() },
        formRequest(token, { origin: userOrigin() }),
      );

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${userOrigin()}/unsubscribe/confirmed`);
      expect(await notificationChannels(database.sql, member, "topic.reply")).toEqual({
        in_app: true,
        email: false,
        digest: false,
      });

      const [audit] = (await database.sql`
        SELECT count(*)::int AS count FROM core.notifications
      `) as Array<{ count: number }>;
      expect(audit?.count).toBe(0);
    });
  }, 30_000);

  test("a digest token turns digest email off", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      await setDigestFrequency(database.sql, member, "weekly");
      const response = await unsubscribeResponse(
        database.sql,
        { secret: SECRET, userOrigin: userOrigin() },
        formRequest(tokenFor(member, "digest"), { origin: userOrigin() }),
      );

      expect(response.status).toBe(303);
      expect(await digestFrequency(database.sql, member)).toBe("off");
    });
  }, 30_000);

  test("an RFC 8058 one-click POST needs only the signed token", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const token = tokenFor(member, "topic.reply");
      const response = await unsubscribeResponse(
        database.sql,
        { secret: SECRET, userOrigin: userOrigin() },
        new Request(
          `http://user.test/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click",
          },
        ),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await notificationChannels(database.sql, member, "topic.reply")).toMatchObject({
        email: false,
      });
    });
  }, 30_000);

  test("an invalid token is refused without changing anything", async () => {
    await withDb(async (database) => {
      const response = await unsubscribeResponse(
        database.sql,
        { secret: SECRET, userOrigin: userOrigin() },
        formRequest("not-a-token", { origin: userOrigin() }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "invalid_token" });
    });
  }, 30_000);
});
