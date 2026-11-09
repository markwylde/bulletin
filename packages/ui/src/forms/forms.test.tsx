import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../i18n/en.json";
import { I18nProvider } from "../i18n.tsx";
import { FormRenderer } from "./FormRenderer.tsx";
import type { FormDefinition, FormField, FormFieldError, FormValues } from "./types.ts";
import { prepareSubmission, validateField, validateForm } from "./validate.ts";

const messages = {
  ...en,
  "test.label": "Label",
  "test.section": "Section",
  "test.option.one": "One",
  "test.option.two": "Two",
};

function definitionFor(field: FormField): FormDefinition {
  return {
    id: "test-form",
    sections: [{ id: "main", titleKey: "test.section", fields: [field] }],
  };
}

function renderForm(
  field: FormField,
  values: FormValues = {},
  initialErrors?: Readonly<Record<string, FormFieldError>>,
): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={messages}>
      <FormRenderer
        definition={definitionFor(field)}
        values={values}
        onChange={() => undefined}
        onSubmit={() => undefined}
        {...(initialErrors === undefined ? {} : { initialErrors })}
      />
    </I18nProvider>,
  );
}

const options = [
  { value: "one", labelKey: "test.option.one" },
  { value: "two", labelKey: "test.option.two" },
];

describe("form field rendering", () => {
  test("renders a text field with length limits and a translated label", () => {
    const markup = renderForm({
      id: "title",
      type: "text",
      labelKey: "test.label",
      minLength: 2,
      maxLength: 12,
    });

    expect(markup).toContain('data-field-type="text"');
    expect(markup).toContain('type="text"');
    expect(markup).toContain("Label");
    expect(markup).toContain('minLength="2"');
    expect(markup).toContain('maxLength="12"');
  });

  test("renders a number field", () => {
    const markup = renderForm(
      { id: "count", type: "number", labelKey: "test.label", min: 1, max: 9 },
      { count: 4 },
    );

    expect(markup).toContain('data-field-type="number"');
    expect(markup).toContain('type="number"');
    expect(markup).toContain('value="4"');
  });

  test("renders a toggle field", () => {
    const markup = renderForm(
      { id: "enabled", type: "toggle", labelKey: "test.label" },
      { enabled: true },
    );

    expect(markup).toContain('data-field-type="toggle"');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("checked");
  });

  test("renders a select field", () => {
    const markup = renderForm(
      { id: "choice", type: "select", labelKey: "test.label", options },
      { choice: "two" },
    );

    expect(markup).toContain('data-field-type="select"');
    expect(markup).toContain("<select");
    expect(markup).toContain("One");
    expect(markup).toContain("Two");
  });

  test("renders multi-select and group/forum pickers as checkbox lists", () => {
    for (const type of ["multi-select", "group-picker", "forum-picker"] as const) {
      const markup = renderForm({ id: "picked", type, labelKey: "test.label", options });

      expect(markup).toContain(`data-field-type="${type}"`);
      expect(markup).toContain(`data-picker="${type}"`);
      expect(markup).toContain('type="checkbox"');
    }
  });

  test("renders a duration field with amount and unit", () => {
    const markup = renderForm(
      { id: "window", type: "duration", labelKey: "test.label", units: ["minutes", "hours"] },
      { window: { amount: 5, unit: "minutes" } },
    );

    expect(markup).toContain('data-field-type="duration"');
    expect(markup).toContain("form-duration");
    expect(markup).toContain('aria-label="Unit"');
    expect(markup).toContain("Minutes");
    expect(markup).toContain("Hours");
  });

  test("renders a markdown field as a textarea", () => {
    const markup = renderForm({ id: "body", type: "markdown", labelKey: "test.label", rows: 5 });

    expect(markup).toContain('data-field-type="markdown"');
    expect(markup).toContain("form-markdown");
    expect(markup).toContain('rows="5"');
  });

  test("shows a translated inline error", () => {
    const markup = renderForm(
      { id: "count", type: "number", labelKey: "test.label", min: 0, max: 10 },
      { count: 12 },
      { count: { fieldId: "count", code: "max", values: { max: 10 } } },
    );

    expect(markup).toContain("Must be at most 10.");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('data-form-error="count"');
  });
});

describe("form validation", () => {
  test("reports required, length, range, option and item errors", () => {
    expect(
      validateField({ id: "title", type: "text", labelKey: "test.label", required: true }, ""),
    ).toMatchObject({ code: "required" });

    expect(
      validateField({ id: "title", type: "text", labelKey: "test.label", minLength: 3 }, "ab"),
    ).toMatchObject({ code: "minLength", values: { minLength: 3 } });

    expect(
      validateField({ id: "count", type: "number", labelKey: "test.label", max: 10 }, 11),
    ).toMatchObject({ code: "max", values: { max: 10 } });

    expect(
      validateField({ id: "count", type: "number", labelKey: "test.label" }, Number.NaN),
    ).toMatchObject({ code: "invalid" });

    expect(
      validateField({ id: "choice", type: "select", labelKey: "test.label", options }, "three"),
    ).toMatchObject({ code: "option" });

    expect(
      validateField(
        {
          id: "picked",
          type: "multi-select",
          labelKey: "test.label",
          options,
          minItems: 2,
        },
        ["one"],
      ),
    ).toMatchObject({ code: "minItems", values: { minItems: 2 } });

    expect(
      validateField(
        { id: "body", type: "markdown", labelKey: "test.label", maxLength: 4 },
        "too long",
      ),
    ).toMatchObject({ code: "maxLength", values: { maxLength: 4 } });

    expect(
      validateField(
        {
          id: "window",
          type: "duration",
          labelKey: "test.label",
          units: ["minutes"],
          min: 60,
        },
        { amount: 0, unit: "minutes" },
      ),
    ).toMatchObject({ code: "min", values: { min: 60 } });

    expect(
      validateField(
        { id: "window", type: "duration", labelKey: "test.label", units: ["minutes"] },
        { amount: 5, unit: "days" },
      ),
    ).toMatchObject({ code: "option" });
  });

  test("does not submit an invalid form", () => {
    const definition = definitionFor({
      id: "count",
      type: "number",
      labelKey: "test.label",
      min: 0,
      max: 10,
    });

    const invalid = prepareSubmission(definition, { count: 11 });
    expect(invalid.shouldSubmit).toBe(false);
    expect(invalid.errors).toMatchObject({ count: { code: "max", values: { max: 10 } } });

    const valid = prepareSubmission(definition, { count: 5 });
    expect(valid.shouldSubmit).toBe(true);
    expect(valid.errors).toEqual({});
  });

  test("treats false and zero as falsy for conditional visibility", () => {
    const definition: FormDefinition = {
      id: "truthy",
      sections: [
        {
          id: "main",
          titleKey: "test.section",
          fields: [
            { id: "enabled", type: "toggle", labelKey: "test.label" },
            { id: "count", type: "number", labelKey: "test.label" },
            {
              id: "dependent",
              type: "text",
              labelKey: "test.label",
              required: true,
              visibleWhen: { field: "enabled", truthy: true },
            },
            {
              id: "countDependent",
              type: "text",
              labelKey: "test.label",
              required: true,
              visibleWhen: { field: "count", truthy: true },
            },
          ],
        },
      ],
    };

    expect(validateForm(definition, { enabled: false, count: 0 })).toEqual({});
    expect(validateForm(definition, { enabled: true, count: 1 })).toMatchObject({
      dependent: { code: "required" },
      countDependent: { code: "required" },
    });
    expect(validateForm(definition, { enabled: false, count: 1 })).toMatchObject({
      countDependent: { code: "required" },
    });
    expect(validateForm(definition, { enabled: true, count: 0 })).toMatchObject({
      dependent: { code: "required" },
    });
  });

  test("validates every visible field and skips hidden ones", () => {
    const definition: FormDefinition = {
      id: "visibility",
      sections: [
        {
          id: "main",
          titleKey: "test.section",
          fields: [
            { id: "notify", type: "toggle", labelKey: "test.label" },
            {
              id: "email",
              type: "text",
              labelKey: "test.label",
              required: true,
              visibleWhen: { field: "notify", equals: true },
            },
          ],
        },
      ],
    };

    expect(validateForm(definition, { notify: false })).toEqual({});
    expect(validateForm(definition, { notify: true })).toMatchObject({
      email: { code: "required" },
    });
  });

  test("hides conditional fields in the rendered form", () => {
    const field: FormField = {
      id: "email",
      type: "text",
      labelKey: "test.label",
      visibleWhen: { field: "notify", equals: true },
    };
    const definition: FormDefinition = {
      id: "visibility",
      sections: [
        {
          id: "main",
          titleKey: "test.section",
          fields: [{ id: "notify", type: "toggle", labelKey: "test.label" }, field],
        },
      ],
    };

    const render = (values: FormValues) =>
      renderToStaticMarkup(
        <I18nProvider locale="en" messages={messages}>
          <FormRenderer
            definition={definition}
            values={values}
            onChange={() => undefined}
            onSubmit={() => undefined}
          />
        </I18nProvider>,
      );

    expect(render({ notify: false })).not.toContain('data-form-field="email"');
    expect(render({ notify: true })).toContain('data-form-field="email"');
  });
});
