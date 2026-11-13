import type { Translator } from "@bulletin/i18n";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useT } from "../i18n.tsx";
import {
  DEFAULT_DURATION_UNITS,
  type DurationUnit,
  type DurationValue,
  type FormDefinition,
  type FormField,
  type FormFieldError,
  type FormValue,
  type FormValues,
  isDurationUnit,
  isDurationValue,
} from "./types.ts";
import { fieldIsVisible, prepareSubmission } from "./validate.ts";

export interface FormRendererProps {
  readonly definition: FormDefinition;
  readonly values: FormValues;
  readonly onChange: (values: FormValues) => void;
  readonly onSubmit: (values: FormValues) => void | Promise<void>;
  readonly disabled?: boolean;
  readonly submitting?: boolean;
  /** Server-rendered or previously submitted errors. */
  readonly initialErrors?: Readonly<Record<string, FormFieldError>>;
}

function stringValue(value: FormValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: FormValue | undefined): number | "" {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function booleanValue(value: FormValue | undefined): boolean {
  return value === true;
}

function listValue(value: FormValue | undefined): readonly string[] {
  return Array.isArray(value) ? value : [];
}

function durationValue(field: FormField, value: FormValue | undefined): DurationValue {
  if (isDurationValue(value)) {
    return value;
  }

  if (field.type === "duration") {
    const units = field.units ?? DEFAULT_DURATION_UNITS;
    return { amount: Number.NaN, unit: units[0] ?? "minutes" };
  }

  return { amount: Number.NaN, unit: "minutes" };
}

function errorMessage(t: Translator, fieldError: FormFieldError): string {
  switch (fieldError.code) {
    case "required":
      return t("ui.form.error.required");
    case "invalid":
      return t("ui.form.error.invalid");
    case "min":
      return t("ui.form.error.min", fieldError.values);
    case "max":
      return t("ui.form.error.max", fieldError.values);
    case "minLength":
      return t("ui.form.error.minLength", fieldError.values);
    case "maxLength":
      return t("ui.form.error.maxLength", fieldError.values);
    case "minItems":
      return t("ui.form.error.minItems", fieldError.values);
    case "maxItems":
      return t("ui.form.error.maxItems", fieldError.values);
    case "option":
      return t("ui.form.error.option");
  }
}

function durationUnitLabel(t: Translator, unit: DurationUnit): string {
  switch (unit) {
    case "seconds":
      return t("ui.form.unit.seconds");
    case "minutes":
      return t("ui.form.unit.minutes");
    case "hours":
      return t("ui.form.unit.hours");
    case "days":
      return t("ui.form.unit.days");
  }
}

export function FormRenderer({
  definition,
  values,
  onChange,
  onSubmit,
  disabled = false,
  submitting = false,
  initialErrors = {},
}: FormRendererProps) {
  const t = useT();
  const formId = useId();
  const [errors, setErrors] = useState<Readonly<Record<string, FormFieldError>>>(initialErrors);

  const setValue = (fieldId: string, value: FormValue | undefined): void => {
    onChange({ ...values, [fieldId]: value });
    setErrors((current) => {
      if (current[fieldId] === undefined) {
        return current;
      }

      const next = { ...current };
      delete next[fieldId];
      return next;
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const submission = prepareSubmission(definition, values);
    setErrors(submission.errors);

    if (!submission.shouldSubmit) {
      return;
    }

    void onSubmit(values);
  };

  const renderControl = (
    field: FormField,
    value: FormValue | undefined,
    error: FormFieldError | undefined,
    inputId: string,
    describedBy: string | undefined,
  ): ReactNode => {
    const shared = {
      id: inputId,
      disabled,
      "aria-invalid": error !== undefined,
      "aria-required": field.required === true,
      ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
    };

    switch (field.type) {
      case "text": {
        const placeholder =
          field.placeholderKey === undefined ? undefined : t(field.placeholderKey);

        return field.multiline === true ? (
          <textarea
            {...shared}
            className="form-input"
            value={stringValue(value)}
            placeholder={placeholder}
            rows={4}
            onChange={(event) => setValue(field.id, event.target.value)}
          />
        ) : (
          <input
            {...shared}
            className="form-input"
            type="text"
            value={stringValue(value)}
            placeholder={placeholder}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onChange={(event) => setValue(field.id, event.target.value)}
          />
        );
      }

      case "number":
        return (
          <input
            {...shared}
            className="form-input"
            type="number"
            value={numberValue(value)}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(event) =>
              setValue(field.id, event.target.value === "" ? undefined : Number(event.target.value))
            }
          />
        );

      case "toggle":
        return (
          <input
            {...shared}
            className="form-checkbox"
            type="checkbox"
            checked={booleanValue(value)}
            onChange={(event) => setValue(field.id, event.target.checked)}
          />
        );

      case "select":
        return (
          <select
            {...shared}
            className="form-input"
            value={stringValue(value)}
            onChange={(event) =>
              setValue(field.id, event.target.value === "" ? undefined : event.target.value)
            }
          >
            <option value="">{t("ui.form.choose")}</option>
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        );

      case "multi-select":
      case "group-picker":
      case "forum-picker": {
        const selected = listValue(value);

        return (
          <div className="form-options" data-picker={field.type}>
            {field.options.map((option) => {
              const checked = selected.includes(option.value);

              return (
                <label key={option.value} className="form-option">
                  <input
                    type="checkbox"
                    value={option.value}
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...selected, option.value]
                        : selected.filter((item) => item !== option.value);
                      setValue(field.id, next);
                    }}
                  />
                  <span>{t(option.labelKey)}</span>
                </label>
              );
            })}
          </div>
        );
      }

      case "duration": {
        const units = field.units ?? DEFAULT_DURATION_UNITS;
        const duration = durationValue(field, value);

        return (
          <div className="form-duration">
            <input
              {...shared}
              className="form-input"
              type="number"
              value={Number.isFinite(duration.amount) ? duration.amount : ""}
              onChange={(event) =>
                setValue(field.id, {
                  ...duration,
                  amount: event.target.value === "" ? Number.NaN : Number(event.target.value),
                })
              }
            />
            <select
              className="form-input"
              value={duration.unit}
              disabled={disabled}
              aria-label={t("ui.form.unit")}
              onChange={(event) => {
                if (isDurationUnit(event.target.value)) {
                  setValue(field.id, { ...duration, unit: event.target.value });
                }
              }}
            >
              {units.map((unit) => (
                <option key={unit} value={unit}>
                  {durationUnitLabel(t, unit)}
                </option>
              ))}
            </select>
          </div>
        );
      }

      case "markdown": {
        const placeholder =
          field.placeholderKey === undefined ? undefined : t(field.placeholderKey);

        return (
          <textarea
            {...shared}
            className="form-input form-markdown"
            value={stringValue(value)}
            placeholder={placeholder}
            rows={field.rows ?? 8}
            minLength={field.minLength}
            maxLength={field.maxLength}
            onChange={(event) => setValue(field.id, event.target.value)}
          />
        );
      }
    }
  };

  const renderField = (field: FormField): ReactNode => {
    if (!fieldIsVisible(field, values)) {
      return null;
    }

    const inputId = `${formId}-${field.id}`;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;
    const fieldError = errors[field.id];
    const describedBy = [
      ...(field.helpKey === undefined ? [] : [helpId]),
      ...(fieldError === undefined ? [] : [errorId]),
    ].join(" ");
    const label = t(field.labelKey);

    return (
      <div
        key={field.id}
        className="form-field"
        data-field-type={field.type}
        data-form-field={field.id}
      >
        {field.type === "toggle" ? (
          <label className="form-toggle" htmlFor={inputId}>
            {renderControl(
              field,
              values[field.id],
              fieldError,
              inputId,
              describedBy === "" ? undefined : describedBy,
            )}
            <span>{label}</span>
          </label>
        ) : (
          <>
            <label className="form-label" htmlFor={inputId}>
              {label}
            </label>
            {renderControl(
              field,
              values[field.id],
              fieldError,
              inputId,
              describedBy === "" ? undefined : describedBy,
            )}
          </>
        )}

        {field.helpKey === undefined ? null : (
          <p className="form-help" id={helpId}>
            {t(field.helpKey)}
          </p>
        )}
        {fieldError === undefined ? null : (
          <p className="form-error" id={errorId} role="alert" data-form-error={field.id}>
            {errorMessage(t, fieldError)}
          </p>
        )}
      </div>
    );
  };

  return (
    <form
      className="form"
      data-form={definition.id}
      data-form-submitting={submitting}
      noValidate
      onSubmit={handleSubmit}
    >
      {definition.sections.map((section) => (
        <fieldset key={section.id} className="form-section">
          <legend>{t(section.titleKey)}</legend>
          {section.descriptionKey === undefined ? null : (
            <p className="form-section-description">{t(section.descriptionKey)}</p>
          )}
          {section.fields.map(renderField)}
        </fieldset>
      ))}
      <div className="form-actions">
        <button type="submit" data-form-submit disabled={disabled || submitting}>
          {submitting
            ? t("ui.form.saving")
            : definition.submitLabelKey === undefined
              ? t("ui.form.submit")
              : t(definition.submitLabelKey)}
        </button>
      </div>
    </form>
  );
}
