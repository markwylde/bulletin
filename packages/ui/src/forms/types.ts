export type DurationUnit = "seconds" | "minutes" | "hours" | "days";

export interface DurationValue {
  readonly amount: number;
  readonly unit: DurationUnit;
}

export type FormValue = string | number | boolean | readonly string[] | DurationValue;
export type FormValues = Readonly<Record<string, FormValue | undefined>>;

export interface FormOption {
  readonly value: string;
  readonly labelKey: string;
}

export type FormVisibility =
  | { readonly field: string; readonly equals: string | number | boolean }
  | { readonly field: string; readonly notEquals: string | number | boolean }
  | { readonly field: string; readonly truthy: boolean };

interface BaseFormField {
  readonly id: string;
  readonly labelKey: string;
  readonly helpKey?: string;
  readonly required?: boolean;
  readonly visibleWhen?: FormVisibility;
}

export interface TextFormField extends BaseFormField {
  readonly type: "text";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  readonly placeholderKey?: string;
}

export interface NumberFormField extends BaseFormField {
  readonly type: "number";
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface ToggleFormField extends BaseFormField {
  readonly type: "toggle";
}

export interface SelectFormField extends BaseFormField {
  readonly type: "select";
  readonly options: readonly FormOption[];
}

export interface MultiSelectFormField extends BaseFormField {
  readonly type: "multi-select";
  readonly options: readonly FormOption[];
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface GroupPickerFormField extends BaseFormField {
  readonly type: "group-picker";
  readonly options: readonly FormOption[];
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface ForumPickerFormField extends BaseFormField {
  readonly type: "forum-picker";
  readonly options: readonly FormOption[];
  readonly minItems?: number;
  readonly maxItems?: number;
}

export interface DurationFormField extends BaseFormField {
  readonly type: "duration";
  /** Bounds are in seconds. */
  readonly min?: number;
  readonly max?: number;
  readonly units?: readonly DurationUnit[];
}

export interface MarkdownFormField extends BaseFormField {
  readonly type: "markdown";
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly rows?: number;
  readonly placeholderKey?: string;
}

export type FormField =
  | TextFormField
  | NumberFormField
  | ToggleFormField
  | SelectFormField
  | MultiSelectFormField
  | GroupPickerFormField
  | ForumPickerFormField
  | DurationFormField
  | MarkdownFormField;

export interface FormSection {
  readonly id: string;
  readonly titleKey: string;
  readonly descriptionKey?: string;
  readonly fields: readonly FormField[];
}

export interface FormDefinition {
  readonly id: string;
  readonly sections: readonly FormSection[];
  readonly submitLabelKey?: string;
}

export type FormErrorCode =
  | "required"
  | "invalid"
  | "min"
  | "max"
  | "minLength"
  | "maxLength"
  | "minItems"
  | "maxItems"
  | "option";

export interface FormFieldError {
  readonly fieldId: string;
  readonly code: FormErrorCode;
  readonly values?: Readonly<Record<string, number>>;
}

export type FormErrors = Readonly<Record<string, FormFieldError>>;

export const DURATION_UNITS: readonly DurationUnit[] = ["seconds", "minutes", "hours", "days"];

export const DEFAULT_DURATION_UNITS: readonly DurationUnit[] = ["minutes", "hours", "days"];

export function isDurationUnit(value: unknown): value is DurationUnit {
  return typeof value === "string" && (DURATION_UNITS as readonly string[]).includes(value);
}

export function isDurationValue(value: FormValue | undefined): value is DurationValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "amount" in value &&
    "unit" in value &&
    typeof value.amount === "number" &&
    isDurationUnit(value.unit)
  );
}

export function durationSeconds(value: DurationValue): number {
  switch (value.unit) {
    case "seconds":
      return value.amount;
    case "minutes":
      return value.amount * 60;
    case "hours":
      return value.amount * 60 * 60;
    case "days":
      return value.amount * 60 * 60 * 24;
  }
}
