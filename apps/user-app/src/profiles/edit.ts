import { editableProfileFieldIds, profileFieldVisibilityClass } from "@bulletin/domain/permissions";
import {
  localizedText,
  type ProfileField,
  type ProfileFieldValue,
  readEditableProfile,
  readProfileFields,
} from "@bulletin/domain/profiles";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

export interface ProfileEditOptionView {
  readonly value: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface ProfileEditFieldView {
  readonly id: string;
  readonly type: ProfileField["type"];
  readonly label: string;
  readonly required: boolean;
  readonly value: string;
  readonly options: readonly ProfileEditOptionView[];
  readonly multiline: boolean;
}

export interface ProfileEditPageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly about: string;
    readonly hideOnline: boolean;
    readonly hideFromMemberList: boolean;
    readonly fields: readonly ProfileEditFieldView[];
  };
}

function textValue(value: ProfileFieldValue | undefined): string {
  if (value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return "";
  }

  return String(value);
}

function selectedValues(value: ProfileFieldValue | undefined): ReadonlySet<string> {
  if (Array.isArray(value)) {
    return new Set(value);
  }

  return typeof value === "string" ? new Set([value]) : new Set();
}

function editField(
  field: ProfileField,
  value: ProfileFieldValue | undefined,
  locale: Locale,
): ProfileEditFieldView {
  const selected = selectedValues(value);
  const label = localizedText(field.labels, locale);

  return {
    id: field.id,
    type: field.type,
    label,
    required: field.required,
    value: textValue(value),
    multiline: field.type === "long_text",
    options: field.options.map((option) => ({
      value: option.value,
      label: localizedText(option.labels, locale),
      selected: selected.has(option.value),
    })),
  };
}

/** The member's own editable profile form; fields are those their groups may edit. */
export async function buildProfileEditPage(input: {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
}): Promise<ProfileEditPageData | null> {
  const editable = await readEditableProfile(input.sql, input.memberId);

  if (editable === null) {
    return null;
  }

  const [fieldClass, editableIds] = await Promise.all([
    profileFieldVisibilityClass(input.sql, input.memberId),
    editableProfileFieldIds(input.sql, input.memberId),
  ]);
  const fields = await readProfileFields(input.sql, fieldClass.ids);
  const title = input.translate("profile.edit.title");

  return {
    title,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: title, href: null },
    ],
    viewModel: {
      about: editable.profile.aboutMd,
      hideOnline: editable.profile.hideOnline,
      hideFromMemberList: editable.profile.hideFromMemberList,
      fields: fields
        .filter((field) => editableIds.has(field.id))
        .map((field) => editField(field, editable.values.get(field.id), input.locale)),
    },
  };
}
