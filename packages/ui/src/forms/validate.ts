import {
  DEFAULT_DURATION_UNITS,
  durationSeconds,
  type FormDefinition,
  type FormErrors,
  type FormField,
  type FormFieldError,
  type FormValue,
  type FormValues,
  isDurationUnit,
  isDurationValue,
} from "./types.ts";

function isPresent(value: FormValue | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function valuesEqual(left: FormValue | undefined, right: string | number | boolean): boolean {
  return left === right;
}

/** Truth-value semantics for conditional visibility; `false` and `0` are falsy. */
function isTruthy(value: FormValue | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return isDurationValue(value) && Number.isFinite(value.amount) && value.amount !== 0;
}

/** Evaluates one declarative visibility condition; missing conditions are visible. */
export function fieldIsVisible(field: FormField, values: FormValues): boolean {
  const condition = field.visibleWhen;

  if (condition === undefined) {
    return true;
  }

  const value = values[condition.field];

  if ("truthy" in condition) {
    const truthy = isTruthy(value);
    return condition.truthy ? truthy : !truthy;
  }

  if ("equals" in condition) {
    return valuesEqual(value, condition.equals);
  }

  return !valuesEqual(value, condition.notEquals);
}

function error(
  field: FormField,
  code: FormFieldError["code"],
  values?: Readonly<Record<string, number>>,
): FormFieldError {
  return {
    fieldId: field.id,
    code,
    ...(values === undefined ? {} : { values }),
  };
}

function optionValues(field: FormField): readonly string[] {
  switch (field.type) {
    case "select":
    case "multi-select":
    case "group-picker":
    case "forum-picker":
      return field.options.map((option) => option.value);
    default:
      return [];
  }
}

export function validateField(
  field: FormField,
  value: FormValue | undefined,
): FormFieldError | null {
  if (!isPresent(value)) {
    return field.required === true ? error(field, "required") : null;
  }

  switch (field.type) {
    case "text":
    case "markdown": {
      if (typeof value !== "string") {
        return error(field, "invalid");
      }

      if (field.minLength !== undefined && value.length < field.minLength) {
        return error(field, "minLength", { minLength: field.minLength });
      }

      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return error(field, "maxLength", { maxLength: field.maxLength });
      }

      return null;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return error(field, "invalid");
      }

      if (field.min !== undefined && value < field.min) {
        return error(field, "min", { min: field.min });
      }

      if (field.max !== undefined && value > field.max) {
        return error(field, "max", { max: field.max });
      }

      return null;
    }

    case "toggle":
      return typeof value === "boolean" ? null : error(field, "invalid");

    case "select": {
      if (typeof value !== "string" || !optionValues(field).includes(value)) {
        return error(field, "option");
      }

      return null;
    }

    case "multi-select":
    case "group-picker":
    case "forum-picker": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        return error(field, "invalid");
      }

      const options = optionValues(field);

      if (value.some((item) => !options.includes(item))) {
        return error(field, "option");
      }

      if (field.minItems !== undefined && value.length < field.minItems) {
        return error(field, "minItems", { minItems: field.minItems });
      }

      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return error(field, "maxItems", { maxItems: field.maxItems });
      }

      return null;
    }

    case "duration": {
      if (!isDurationValue(value) || !Number.isFinite(value.amount)) {
        return error(field, "invalid");
      }

      const units = field.units ?? DEFAULT_DURATION_UNITS;

      if (!units.includes(value.unit) || !isDurationUnit(value.unit)) {
        return error(field, "option");
      }

      const seconds = durationSeconds(value);

      if (field.min !== undefined && seconds < field.min) {
        return error(field, "min", { min: field.min });
      }

      if (field.max !== undefined && seconds > field.max) {
        return error(field, "max", { max: field.max });
      }

      return null;
    }
  }
}

/** Validates every visible field, so hidden fields never block submission. */
export function validateForm(definition: FormDefinition, values: FormValues): FormErrors {
  const errors: Record<string, FormFieldError> = {};

  for (const section of definition.sections) {
    for (const field of section.fields) {
      if (!fieldIsVisible(field, values)) {
        continue;
      }

      const fieldError = validateField(field, values[field.id]);

      if (fieldError !== null) {
        errors[field.id] = fieldError;
      }
    }
  }

  return errors;
}

export interface FormSubmission {
  readonly errors: FormErrors;
  readonly shouldSubmit: boolean;
}

/** The submit decision, kept pure so the renderer and tests share one rule. */
export function prepareSubmission(definition: FormDefinition, values: FormValues): FormSubmission {
  const errors = validateForm(definition, values);
  return { errors, shouldSubmit: Object.keys(errors).length === 0 };
}
