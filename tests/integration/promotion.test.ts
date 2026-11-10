import { describe, expect, test } from "bun:test";
import {
  evaluatePromotion,
  listPromotionCandidates,
  runNightlyPromotionSweep,
} from "@bulletin/db/jobs";
import { displayNameSkeleton } from "@bulletin/domain/member";
import {
  createPromotionCriteriaRegistry,
  daysSinceJoiningCriterion,
} from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const NOW = new Date("2026-11-10T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [group] = (await database.sql`
    SELECT id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return group.id;
}

async function createGroup(database: TestDatabase, key: string, title: string): Promise<string> {
  const [group] = (await database.sql`
    INSERT INTO core.groups (key, title, display_order)
    VALUES (${key}, ${title}, 100)
    RETURNING id
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error(`Could not create group ${key}`);
  }

  return group.id;
}

async function createMember(
  database: TestDatabase,
  name: string,
  primaryGroup: string,
  joinedAt: Date,
  secondaryGroups: readonly string[] = [],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton, joined_at)
    VALUES (${name}, ${displayNameSkeleton(name)}, ${joinedAt})
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  await database.sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    VALUES (${member.id}, ${primaryGroup}, true)
  `;

  for (const group of secondaryGroups) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      VALUES (${member.id}, ${group}, false)
    `;
  }

  return member.id;
}

async function createSession(database: TestDatabase, memberId: string): Promise<string> {
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (
      ${memberId}, 'user', sha256(convert_to(${crypto.randomUUID()}, 'UTF8')),
      now() + interval '24 hours'
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create session");
  }

  return session.id;
}

async function addRule(
  database: TestDatabase,
  rule: {
    readonly from: string;
    readonly to: string;
    readonly criteria?: Readonly<Record<string, number>>;
    readonly position?: number;
    readonly enabled?: boolean;
  },
): Promise<string> {
  const [row] = (await database.sql`
    INSERT INTO core.promotion_rules (
      from_group_id, to_group_id, criteria, position, enabled
    ) VALUES (
      ${rule.from},
      ${rule.to},
      ${rule.criteria ?? {}},
      ${rule.position ?? 0},
      ${rule.enabled ?? true}
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create promotion rule");
  }

  return row.id;
}

async function memberRows(
  database: TestDatabase,
  memberId: string,
): Promise<Array<{ key: string; is_primary: boolean }>> {
  return (await database.sql`
    SELECT g.key, mg.is_primary
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE mg.member_id = ${memberId}
    ORDER BY g.key
  `) as Array<{ key: string; is_primary: boolean }>;
}

async function promotionEvents(database: TestDatabase): Promise<
  Array<{
    type: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    payload_ids: Record<string, string>;
  }>
> {
  const rows = (await database.sql`
    SELECT
      type,
      aggregate_type,
      aggregate_id::text AS aggregate_id,
      aggregate_version::text AS aggregate_version,
      payload_ids
    FROM core.events
    WHERE type = 'member.promoted'
    ORDER BY id
  `) as Array<{
    type: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: string;
    payload_ids: Record<string, string> | string;
  }>;

  return rows.map((row) => ({
    ...row,
    payload_ids:
      typeof row.payload_ids === "string"
        ? (JSON.parse(row.payload_ids) as Record<string, string>)
        : row.payload_ids,
  }));
}

integrationDescribe("auto-promotion", () => {
  test("promotes on days since joining and emits member.promoted", async () => {
    await withDb("promotion_days", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const member = await createMember(
        database,
        "Promoted Member",
        members,
        new Date(NOW.getTime() - 30 * DAY_MS),
      );
      const rule = await addRule(database, {
        from: members,
        to: regulars,
        criteria: { days_since_joining: 30 },
      });

      const result = await evaluatePromotion(database.sql, member, { now: NOW });

      expect(result).toMatchObject({
        kind: "promoted",
        memberId: member,
        fromGroupId: members,
        toGroupId: regulars,
        ruleId: rule,
      });
      expect(await memberRows(database, member)).toEqual([{ key: "regulars", is_primary: true }]);

      const [stored] = (await database.sql`
        SELECT promotion_version::text AS version FROM core.members WHERE id = ${member}
      `) as Array<{ version: string }>;
      expect(stored?.version).toBe("1");

      expect(await promotionEvents(database)).toEqual([
        {
          type: "member.promoted",
          aggregate_type: "member",
          aggregate_id: member,
          aggregate_version: "1",
          payload_ids: {
            memberId: member,
            fromGroupId: members,
            toGroupId: regulars,
            ruleId: rule,
          },
        },
      ]);

      expect(await evaluatePromotion(database.sql, member, { now: NOW })).toEqual({
        kind: "none",
      });
      expect(await promotionEvents(database)).toHaveLength(1);
    });
  }, 30_000);

  test("does not promote a member below the threshold", async () => {
    await withDb("promotion_below", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const member = await createMember(
        database,
        "Young Member",
        members,
        new Date(NOW.getTime() - 20 * DAY_MS),
      );

      await addRule(database, {
        from: members,
        to: regulars,
        criteria: { days_since_joining: 30 },
      });

      expect(await evaluatePromotion(database.sql, member, { now: NOW })).toEqual({
        kind: "none",
      });
      expect(await memberRows(database, member)).toEqual([{ key: "members", is_primary: true }]);
      expect(await promotionEvents(database)).toHaveLength(0);
    });
  }, 30_000);

  test("evaluates only enabled rules from the current primary group, in order", async () => {
    await withDb("promotion_order", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const vip = await createGroup(database, "vip", "VIP");

      await addRule(database, {
        from: members,
        to: vip,
        position: 0,
        enabled: false,
      });
      await addRule(database, {
        from: members,
        to: vip,
        position: 1,
        criteria: { days_since_joining: 60 },
      });
      await addRule(database, {
        from: members,
        to: regulars,
        position: 2,
        criteria: { days_since_joining: 30 },
      });

      const member = await createMember(
        database,
        "Ordered Member",
        members,
        new Date(NOW.getTime() - 30 * DAY_MS),
      );

      const result = await evaluatePromotion(database.sql, member, { now: NOW });
      expect(result).toMatchObject({ kind: "promoted", toGroupId: regulars });

      const firstMatch = await createMember(
        database,
        "First Match Member",
        members,
        new Date(NOW.getTime() - 90 * DAY_MS),
      );
      await addRule(database, {
        from: members,
        to: vip,
        position: 0,
        criteria: { days_since_joining: 60 },
      });

      expect(await evaluatePromotion(database.sql, firstMatch, { now: NOW })).toMatchObject({
        kind: "promoted",
        toGroupId: vip,
      });
    });
  }, 30_000);

  test("runs a criterion registered by a later change (approved posts)", async () => {
    await withDb("promotion_posts", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const counts = new Map<string, number>();
      const criteria = createPromotionCriteriaRegistry([
        daysSinceJoiningCriterion,
        {
          key: "approved_posts",
          labelKey: "test.promotionCriterion.approvedPosts",
          read: async ({ memberId }) => counts.get(memberId) ?? 0,
        },
      ]);

      await addRule(database, {
        from: members,
        to: regulars,
        criteria: { approved_posts: 10 },
      });

      const prolific = await createMember(
        database,
        "Prolific Member",
        members,
        new Date(NOW.getTime() - 2 * DAY_MS),
      );
      const quiet = await createMember(
        database,
        "Quiet Member",
        members,
        new Date(NOW.getTime() - 2 * DAY_MS),
      );
      counts.set(prolific, 12);
      counts.set(quiet, 5);

      expect(await evaluatePromotion(database.sql, prolific, { now: NOW, criteria })).toMatchObject(
        { kind: "promoted", toGroupId: regulars },
      );
      expect(await evaluatePromotion(database.sql, quiet, { now: NOW, criteria })).toEqual({
        kind: "none",
      });
    });
  }, 30_000);

  test("fails closed when a rule names an unknown criterion", async () => {
    await withDb("promotion_unknown", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const member = await createMember(
        database,
        "Unknown Criterion Member",
        members,
        new Date(NOW.getTime() - 90 * DAY_MS),
      );

      await addRule(database, {
        from: members,
        to: regulars,
        criteria: { reputation: 5 },
      });

      expect(await evaluatePromotion(database.sql, member, { now: NOW })).toEqual({
        kind: "none",
      });
    });
  }, 30_000);

  test("two concurrent evaluations apply the promotion exactly once", async () => {
    await withDb("promotion_concurrent", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const member = await createMember(
        database,
        "Concurrent Member",
        members,
        new Date(NOW.getTime() - 30 * DAY_MS),
      );

      await addRule(database, {
        from: members,
        to: regulars,
        criteria: { days_since_joining: 30 },
      });

      const results = await Promise.all([
        evaluatePromotion(database.sql, member, { now: NOW }),
        evaluatePromotion(database.sql, member, { now: NOW }),
      ]);

      expect(results.filter((result) => result.kind === "promoted")).toHaveLength(1);
      expect(results.filter((result) => result.kind === "none")).toHaveLength(1);
      expect(await memberRows(database, member)).toEqual([{ key: "regulars", is_primary: true }]);
      expect(await promotionEvents(database)).toHaveLength(1);

      const [stored] = (await database.sql`
        SELECT promotion_version::text AS version FROM core.members WHERE id = ${member}
      `) as Array<{ version: string }>;
      expect(stored?.version).toBe("1");
    });
  }, 30_000);

  test("moves a secondary target to primary and rotates the member's sessions", async () => {
    await withDb("promotion_rotate", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const member = await createMember(
        database,
        "Rotating Member",
        members,
        new Date(NOW.getTime() - 30 * DAY_MS),
        [regulars],
      );
      const session = await createSession(database, member);

      await addRule(database, {
        from: members,
        to: regulars,
        criteria: { days_since_joining: 30 },
      });

      expect(await evaluatePromotion(database.sql, member, { now: NOW })).toMatchObject({
        kind: "promoted",
      });

      expect(await memberRows(database, member)).toEqual([{ key: "regulars", is_primary: true }]);

      const [stored] = (await database.sql`
        SELECT rotate_pending FROM core.sessions WHERE id = ${session}
      `) as Array<{ rotate_pending: boolean }>;
      expect(stored?.rotate_pending).toBe(true);
    });
  }, 30_000);

  test("lists only members whose primary group starts an enabled rule", async () => {
    await withDb("promotion_nightly", async (database) => {
      const members = await groupId(database, "members");
      const regulars = await createGroup(database, "regulars", "Regulars");
      const vip = await createGroup(database, "vip", "VIP");

      await addRule(database, {
        from: members,
        to: regulars,
        criteria: { days_since_joining: 30 },
      });
      await addRule(database, {
        from: vip,
        to: regulars,
        criteria: { days_since_joining: 30 },
        enabled: false,
      });

      const candidate = await createMember(
        database,
        "Candidate Member",
        members,
        new Date(NOW.getTime() - 30 * DAY_MS),
      );
      const otherPrimary = await createMember(
        database,
        "Other Primary Member",
        vip,
        new Date(NOW.getTime() - 30 * DAY_MS),
      );
      await createMember(
        database,
        "No Rule Member",
        await groupId(database, "guests"),
        new Date(NOW.getTime() - 30 * DAY_MS),
        [],
      );

      const candidates = await listPromotionCandidates(database.sql);
      expect(candidates).toContain(candidate);
      expect(candidates).not.toContain(otherPrimary);

      const enqueued: string[] = [];
      expect(
        await runNightlyPromotionSweep(database.sql, async (memberId) => {
          enqueued.push(memberId);
        }),
      ).toBeGreaterThan(0);
      expect(enqueued.length).toBeGreaterThan(0);

      for (const memberId of enqueued) {
        await evaluatePromotion(database.sql, memberId, { now: NOW });
      }

      expect(await memberRows(database, candidate)).toEqual([
        { key: "regulars", is_primary: true },
      ]);
    });
  }, 30_000);

  test("returns missing for an unknown member", async () => {
    await withDb("promotion_missing", async (database) => {
      expect(await evaluatePromotion(database.sql, "999999", { now: NOW })).toEqual({
        kind: "missing",
      });
    });
  }, 30_000);

  test("the workers role can apply promotions and emit events", async () => {
    await withDb("promotion_grants", async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_table_privilege('workers', 'core.promotion_rules', 'SELECT') AS rules_select,
          has_table_privilege('workers', 'core.members', 'UPDATE') AS members_update,
          has_table_privilege('workers', 'core.member_groups', 'UPDATE') AS groups_update,
          has_table_privilege('workers', 'core.events', 'INSERT') AS events_insert
      `) as Array<Record<string, boolean>>;

      expect(privileges).toMatchObject({
        rules_select: true,
        members_update: true,
        groups_update: true,
        events_insert: true,
      });
    });
  }, 30_000);
});
