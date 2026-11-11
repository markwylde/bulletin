import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { can } from "@bulletin/domain/permissions";
import { readProfile } from "@bulletin/domain/profiles";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  mutateMemberProfileForStaff,
  readMemberProfileForStaff,
} from "../../apps/staff-api/src/profiles.ts";
import { profileSaveResponse } from "../../apps/user-api/src/profile.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "profile_edit" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        forumExtrasSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        flagsSeedModule,
        themesSeedModule,
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

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return row.id;
}

async function createField(
  database: TestDatabase,
  input: {
    readonly type: string;
    readonly label: string;
    readonly required?: boolean;
    readonly visibleTo: readonly string[];
    readonly editableBy?: readonly string[];
  },
): Promise<string> {
  const labels = { en: input.label, es: input.label, fr: input.label };
  const [field] = (await database.sql`
    INSERT INTO core.profile_fields (type, required, labels, options)
    VALUES (${input.type}, ${input.required === true}, ${labels}::jsonb, '[]'::jsonb)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (field === undefined) {
    throw new Error("Could not create the field");
  }

  for (const key of input.visibleTo) {
    await database.sql`
      INSERT INTO core.profile_field_groups (field_id, group_id, can_view, can_edit)
      VALUES (
        ${field.id},
        ${await groupId(database, key)},
        true,
        ${(input.editableBy ?? []).includes(key)}
      )
    `;
  }

  return field.id;
}

function request(body: unknown): Request {
  return new Request("http://bulletin.localhost/api/me/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function session(memberId: string) {
  return { memberId, id: "0" } as never;
}

integrationDescribe("profile editing", () => {
  test("saves about, editable fields and privacy options with sanitised HTML", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const bio = await createField(database, {
        type: "short_text",
        label: "Bio",
        visibleTo: ["members"],
        editableBy: ["members"],
      });

      const response = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "Hello **world** <script>alert(1)</script>",
          hideOnline: true,
          hideFromMemberList: true,
          values: { [bio]: "Builder" },
        }),
      );

      expect(response.status).toBe(200);
      expect((await response.json()) as unknown).toEqual({ ok: true });

      const profile = await readProfile(database.sql, member);
      expect(profile?.aboutMd).toContain("Hello **world**");
      expect(profile?.aboutHtml).toContain("<strong>world</strong>");
      expect(profile?.aboutHtml).not.toContain("<script");
      expect(profile?.hideOnline).toBe(true);
      expect(profile?.hideFromMemberList).toBe(true);

      const [value] = (await database.sql`
        SELECT value FROM core.member_field_values
        WHERE member_id = ${member} AND field_id = ${bio}
      `) as Array<{ value: string }>;
      expect(value?.value).toBe("Builder");
    });
  });

  test("rejects a save that misses a required editable field", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      await createField(database, {
        type: "long_text",
        label: "Required note",
        required: true,
        visibleTo: ["members"],
        editableBy: ["members"],
      });

      const response = await profileSaveResponse(
        database.sql,
        session(member),
        request({ about: "", hideOnline: false, hideFromMemberList: false, values: {} }),
      );

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("required");
    });
  });

  test("rejects a value for a field the member's groups cannot edit", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const moderatorField = await createField(database, {
        type: "short_text",
        label: "Moderator note",
        visibleTo: ["moderators"],
        editableBy: ["moderators"],
      });

      expect(
        await can(database.sql, member, "edit_profile_field", { fieldId: moderatorField }),
      ).toBe(false);

      const response = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "",
          hideOnline: false,
          hideFromMemberList: false,
          values: { [moderatorField]: "not mine" },
        }),
      );

      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("not_editable");

      const [row] = (await database.sql`
        SELECT 1 FROM core.member_field_values
        WHERE member_id = ${member} AND field_id = ${moderatorField}
      `) as unknown[];
      expect(row).toBeUndefined();
    });
  });

  test("staff editing requires members.edit and records the change", async () => {
    await withDb(async (database) => {
      const admin = await memberId(database, "admin");
      const regular = await memberId(database, "member-2");
      const target = await memberId(database, "member-1");
      const field = await createField(database, {
        type: "short_text",
        label: "Staff-visible bio",
        visibleTo: [],
      });

      expect(
        (
          await mutateMemberProfileForStaff(database.sql, regular, {
            memberId: target,
            about: "should not save",
          })
        ).code,
      ).toBe("forbidden");

      const result = await mutateMemberProfileForStaff(database.sql, admin, {
        memberId: target,
        about: "Staff-edited **about**",
        hideOnline: false,
        hideFromMemberList: true,
        values: { [field]: "Set by staff" },
      });

      expect(result.ok).toBe(true);
      expect((await readProfile(database.sql, target))?.hideFromMemberList).toBe(true);

      const [value] = (await database.sql`
        SELECT value FROM core.member_field_values
        WHERE member_id = ${target} AND field_id = ${field}
      `) as Array<{ value: string }>;
      expect(value?.value).toBe("Set by staff");

      const log = (await database.sql`
        SELECT action, target_id::text AS target_id
        FROM core.admin_log
        WHERE action = 'member.profile.edit'
      `) as Array<{ action: string; target_id: string }>;
      expect(log).toEqual([{ action: "member.profile.edit", target_id: target }]);

      const read = await readMemberProfileForStaff(database.sql, admin, target);
      expect(read.ok).toBe(true);
      expect(read.ok && read.profile.about).toContain("Staff-edited **about**");
    });
  });

  test("saves preserve restricted field values and a fields-off save deletes nothing", async () => {
    await withDb(async (database) => {
      const member = await memberId(database, "member-1");
      const editable = await createField(database, {
        type: "short_text",
        label: "Editable field",
        visibleTo: ["members"],
        editableBy: ["members"],
      });
      const restricted = await createField(database, {
        type: "short_text",
        label: "Restricted field",
        visibleTo: ["moderators"],
        editableBy: ["moderators"],
      });

      await database.sql`
        INSERT INTO core.member_field_values (member_id, field_id, value)
        VALUES (${member}, ${restricted}, '"Staff only"'::jsonb)
      `;

      const saved = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "",
          hideOnline: false,
          hideFromMemberList: false,
          hideSignatures: false,
          hideFriends: false,
          signatureMd: "",
          values: { [editable]: "Member value" },
        }),
      );
      expect(saved.status).toBe(200);

      const afterMemberSave = (await database.sql`
        SELECT field_id::text AS field_id, value
        FROM core.member_field_values
        WHERE member_id = ${member}
        ORDER BY field_id
      `) as Array<{ field_id: string; value: string }>;
      expect(afterMemberSave).toEqual(
        expect.arrayContaining([
          { field_id: editable, value: "Member value" },
          { field_id: restricted, value: "Staff only" },
        ]),
      );

      const off = await profileSaveResponse(
        database.sql,
        session(member),
        request({
          about: "",
          hideOnline: false,
          hideFromMemberList: false,
          hideSignatures: false,
          hideFriends: false,
          signatureMd: "",
          values: {},
        }),
        {
          customFields: false,
          signatures: false,
          customTitles: false,
          badges: false,
        },
      );
      expect(off.status).toBe(200);

      const afterOffSave = (await database.sql`
        SELECT field_id::text AS field_id, value
        FROM core.member_field_values
        WHERE member_id = ${member}
        ORDER BY field_id
      `) as Array<{ field_id: string; value: string }>;
      expect(afterOffSave).toEqual(afterMemberSave);
    });
  });
});
