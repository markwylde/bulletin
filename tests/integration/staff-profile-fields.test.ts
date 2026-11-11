import { describe, expect, test } from "bun:test";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "profile_fields" }, run);
}

async function createMember(
  database: TestDatabase,
  name: string,
  groupKey: string,
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${displayNameSkeleton(name)})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  await database.sql`
    INSERT INTO core.member_groups (member_id, group_id, is_primary)
    SELECT ${member.id}, id, true FROM core.groups WHERE key = ${groupKey}
  `;

  // A staff member with the shell permission can reach the route; the field manager adds its
  // own `acp.profile_fields` permission below.
  if (groupKey === "members") {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      SELECT ${await groupId(database, "members")}, 'acp.access', 'true'::jsonb
      ON CONFLICT (group_id, key) DO NOTHING
    `;
  }

  return member.id;
}

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return row.id;
}

function route(id: string): StaffRoute {
  const found = STAFF_ROUTES.find((entry) => entry.id === id);

  if (found === undefined) {
    throw new Error(`Missing staff route ${id}`);
  }

  return found;
}

function call(
  database: TestDatabase,
  memberId: string,
  target: StaffRoute,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`http://staff.localhost${target.path}`);

  return authorizeStaffRoute(target, {
    request: new Request(url, {
      method: target.method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    url,
    session: { memberId, lastAuthAt: new Date() } as never,
    sql: database.sql,
    checks: [],
  });
}

const LABELS = { en: "Favourite colour", es: "Color favorito", fr: "Couleur préférée" };

integrationDescribe("staff custom profile field manager", () => {
  test("requires acp.profile_fields and logs every change", async () => {
    await withDb(async (database) => {
      const admin = await createMember(database, "Field Admin", "administrators");
      const member = await createMember(database, "Field Member", "members");
      const list = route("profileFields.list");
      const mutate = route("profileFields.mutate");
      const membersGroup = await groupId(database, "members");

      expect(list.permission).toBe("acp.profile_fields");
      expect((await call(database, member, list)).status).toBe(403);

      const empty = await call(database, admin, list);
      expect(empty.status).toBe(200);
      expect((await empty.json()) as unknown).toEqual({
        fields: [],
        groups: expect.any(Array),
      });

      const created = await call(database, admin, mutate, {
        action: "save",
        field: {
          type: "select",
          required: true,
          position: 2,
          labels: LABELS,
          options: [
            { value: "red", labels: { en: "Red", es: "Rojo", fr: "Rouge" } },
            { value: "blue", labels: { en: "Blue", es: "Azul", fr: "Bleu" } },
          ],
          groups: [{ groupId: membersGroup, canView: true, canEdit: true }],
        },
      });
      expect(created.status).toBe(200);
      const createdBody = (await created.json()) as { id: string };
      expect(createdBody.id).toMatch(/^\d+$/);

      const listed = (await (await call(database, admin, list)).json()) as {
        fields: Array<{
          id: string;
          type: string;
          required: boolean;
          labels: Record<string, string>;
          options: Array<{ value: string }>;
          groups: Array<{ groupId: string; canView: boolean; canEdit: boolean }>;
        }>;
      };
      expect(listed.fields).toHaveLength(1);
      expect(listed.fields[0]?.type).toBe("select");
      expect(listed.fields[0]?.required).toBe(true);
      expect(listed.fields[0]?.labels).toEqual(LABELS);
      expect(listed.fields[0]?.options.map((option) => option.value)).toEqual(["red", "blue"]);
      expect(listed.fields[0]?.groups).toEqual([
        { groupId: membersGroup, groupTitle: "Members", canView: true, canEdit: true },
      ]);

      // A malformed payload (no Spanish label) is refused.
      const invalid = await call(database, admin, mutate, {
        action: "save",
        field: {
          type: "short_text",
          labels: { en: "Only English", es: "", fr: "" },
          options: [],
          groups: [],
        },
      });
      expect(invalid.status).toBe(400);

      const updated = await call(database, admin, mutate, {
        action: "save",
        field: {
          id: createdBody.id,
          type: "short_text",
          required: false,
          position: 1,
          labels: LABELS,
          options: [],
          groups: [],
        },
      });
      expect(updated.status).toBe(200);

      const deleted = await call(database, admin, mutate, {
        action: "delete",
        id: createdBody.id,
      });
      expect(deleted.status).toBe(200);

      const log = (await database.sql`
        SELECT action, target_id::text AS target_id
        FROM core.admin_log
        WHERE target_type = 'profile_field'
        ORDER BY id
      `) as Array<{ action: string; target_id: string }>;
      expect(log).toEqual([
        { action: "member.profile_field.create", target_id: createdBody.id },
        { action: "member.profile_field.update", target_id: createdBody.id },
        { action: "member.profile_field.delete", target_id: createdBody.id },
      ]);
    });
  });

  test("rejects a type change when stored values do not fit the new type", async () => {
    await withDb(async (database) => {
      const admin = await createMember(database, "Field Admin", "administrators");
      const member = await createMember(database, "Field Member", "members");
      const mutate = route("profileFields.mutate");

      const created = await call(database, admin, mutate, {
        action: "save",
        field: {
          type: "short_text",
          labels: LABELS,
          options: [],
          groups: [],
        },
      });
      expect(created.status).toBe(200);
      const fieldId = ((await created.json()) as { id: string }).id;

      await database.sql`
        INSERT INTO core.member_field_values (member_id, field_id, value)
        VALUES (${member}, ${fieldId}, '"January 1, 2020"'::jsonb)
      `;

      const asDate = await call(database, admin, mutate, {
        action: "save",
        field: {
          id: fieldId,
          type: "date",
          labels: LABELS,
          options: [],
          groups: [],
        },
      });
      expect(asDate.status).toBe(400);
      expect(((await asDate.json()) as { code: string }).code).toBe("incompatible_values");

      const [unchanged] = (await database.sql`
        SELECT type FROM core.profile_fields WHERE id = ${fieldId}
      `) as Array<{ type: string }>;
      expect(unchanged?.type).toBe("short_text");

      // A value that does fit the new type lets the change through.
      await database.sql`
        UPDATE core.member_field_values SET value = '"2020-01-01"'::jsonb
        WHERE member_id = ${member} AND field_id = ${fieldId}
      `;
      const migrated = await call(database, admin, mutate, {
        action: "save",
        field: {
          id: fieldId,
          type: "date",
          labels: LABELS,
          options: [],
          groups: [],
        },
      });
      expect(migrated.status).toBe(200);
    });
  });
});
