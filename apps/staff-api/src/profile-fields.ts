import {
  listProfileFieldsAdmin,
  listProfileGroups,
  parseProfileFieldInput,
  removeProfileField,
  saveProfileField,
} from "@bulletin/domain/profiles";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export interface StaffProfileFieldView {
  readonly id: string;
  readonly type: string;
  readonly required: boolean;
  readonly labels: Readonly<Record<string, string>>;
  readonly options: readonly {
    readonly value: string;
    readonly labels: Readonly<Record<string, string>>;
  }[];
  readonly position: number;
  readonly groups: readonly {
    readonly groupId: string;
    readonly groupTitle: string;
    readonly canView: boolean;
    readonly canEdit: boolean;
  }[];
}

export interface StaffProfileFieldsView {
  readonly fields: readonly StaffProfileFieldView[];
  readonly groups: readonly { readonly id: string; readonly title: string }[];
}

/** `GET /api/staff/profile-fields`: definitions, options and per-group rules. */
export async function listProfileFieldsForStaff(sql: SQL): Promise<StaffProfileFieldsView> {
  return {
    fields: await listProfileFieldsAdmin(sql),
    groups: await listProfileGroups(sql),
  };
}

export type ProfileFieldStaffMutation =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly code: string };

/** `POST /api/staff/profile-fields` with `{action: "save" | "delete"}`; every write is logged. */
export async function mutateProfileFieldForStaff(
  sql: SQL,
  actorMemberId: string,
  body: unknown,
): Promise<ProfileFieldStaffMutation> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, code: "invalid" };
  }

  const input = body as Record<string, unknown>;

  if (input.action === "delete") {
    const id = typeof input.id === "string" ? input.id : "";
    const result = await removeProfileField(sql, id);

    if (result.ok) {
      await writeAdminLog(sql, {
        actorMemberId,
        action: "member.profile_field.delete",
        targetType: "profile_field",
        targetId: id,
        summary: { id },
      });
    }

    return result;
  }

  if (input.action !== "save") {
    return { ok: false, code: "invalid" };
  }

  const parsed = parseProfileFieldInput(input.field);

  if (parsed === null) {
    return { ok: false, code: "invalid" };
  }

  const result = await saveProfileField(sql, parsed);

  if (result.ok) {
    await writeAdminLog(sql, {
      actorMemberId,
      action: parsed.id === null ? "member.profile_field.create" : "member.profile_field.update",
      targetType: "profile_field",
      targetId: result.id,
      summary: {
        type: parsed.type,
        required: parsed.required,
        position: parsed.position,
        groups: parsed.groups,
      },
    });
  }

  return result;
}
