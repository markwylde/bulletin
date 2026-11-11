import { can } from "@bulletin/domain/permissions";
import {
  listProfileFields,
  type ProfileFieldValue,
  readEditableProfile,
  saveMemberProfile,
} from "@bulletin/domain/profiles";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export interface StaffMemberProfileField {
  readonly id: string;
  readonly type: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly required: boolean;
  readonly value: ProfileFieldValue | null;
  readonly options: readonly {
    readonly value: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
}

export interface StaffMemberProfileView {
  readonly memberId: string;
  readonly displayName: string;
  readonly about: string;
  readonly hideOnline: boolean;
  readonly hideFromMemberList: boolean;
  readonly fields: readonly StaffMemberProfileField[];
}

export type StaffMemberProfileRead =
  | { readonly ok: true; readonly profile: StaffMemberProfileView }
  | { readonly ok: false; readonly code: "forbidden" | "not_found" };

/** Staff profile editing requires `members.edit`, not the section's ACP permission (spec). */
export async function readMemberProfileForStaff(
  sql: SQL,
  actorId: string,
  memberId: string,
): Promise<StaffMemberProfileRead> {
  if (!(await can(sql, actorId, "members.edit"))) {
    return { ok: false, code: "forbidden" };
  }

  if (!/^\d+$/.test(memberId)) {
    return { ok: false, code: "not_found" };
  }

  const editable = await readEditableProfile(sql, memberId);

  if (editable === null || editable.profile.displayName === null) {
    return { ok: false, code: "not_found" };
  }

  const fields = await listProfileFields(sql);

  return {
    ok: true,
    profile: {
      memberId,
      displayName: editable.profile.displayName,
      about: editable.profile.aboutMd,
      hideOnline: editable.profile.hideOnline,
      hideFromMemberList: editable.profile.hideFromMemberList,
      fields: fields.map((field) => ({
        id: field.id,
        type: field.type,
        labels: field.labels,
        required: field.required,
        value: editable.values.get(field.id) ?? null,
        options: field.options.map((option) => ({
          value: option.value,
          labels: option.labels,
        })),
      })),
    },
  };
}

export type StaffMemberProfileMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "forbidden" | "not_found" | "invalid" };

/** `POST /api/staff/members/profile`: staff edits any member's profile, always logged. */
export async function mutateMemberProfileForStaff(
  sql: SQL,
  actorId: string,
  body: unknown,
): Promise<StaffMemberProfileMutation> {
  if (!(await can(sql, actorId, "members.edit"))) {
    return { ok: false, code: "forbidden" };
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "invalid" };
  }

  const input = body as Record<string, unknown>;
  const memberId = typeof input.memberId === "string" ? input.memberId : "";
  const about = typeof input.about === "string" ? input.about : "";
  const values =
    typeof input.values === "object" && input.values !== null && !Array.isArray(input.values)
      ? (input.values as Record<string, unknown>)
      : {};

  if (!/^\d+$/.test(memberId)) {
    return { ok: false, code: "invalid" };
  }

  const editable = await readEditableProfile(sql, memberId);

  if (editable === null || editable.profile.displayName === null) {
    return { ok: false, code: "not_found" };
  }

  const result = await saveMemberProfile(sql, {
    memberId,
    aboutMd: about,
    hideOnline: input.hideOnline === true,
    hideFromMemberList: input.hideFromMemberList === true,
    values,
    fields: await listProfileFields(sql),
  });

  if (!result.ok) {
    return { ok: false, code: "invalid" };
  }

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: "member.profile.edit",
    targetType: "member",
    targetId: memberId,
    summary: {
      aboutChanged: about !== editable.profile.aboutMd,
      hideOnline: input.hideOnline === true,
      hideFromMemberList: input.hideFromMemberList === true,
      fieldsChanged: Object.keys(values),
    },
  });

  return { ok: true };
}
