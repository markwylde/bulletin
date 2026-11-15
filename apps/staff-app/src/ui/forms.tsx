import {
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";

interface FieldProps {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  /** Renders the control with the ids it must use for label and description. */
  readonly children: (ids: { id: string; describedBy: string | undefined }) => ReactNode;
  readonly id?: string;
}

function useFieldIds(id: string | undefined, description: unknown, error: unknown) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const describedBy =
    [
      description === undefined ? null : `${controlId}-description`,
      error === undefined ? null : `${controlId}-error`,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return { controlId, describedBy };
}

/** Label above the control. For dialogs and dense forms. */
export function Field({ label, description, error, children, id }: FieldProps) {
  const { controlId, describedBy } = useFieldIds(id, description, error);

  return (
    <div className="field">
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      {children({ id: controlId, describedBy })}
      {description === undefined ? null : (
        <p className="field-description" id={`${controlId}-description`}>
          {description}
        </p>
      )}
      {error === undefined ? null : (
        <p className="field-error" id={`${controlId}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Settings layout (ADR 0021): label and description on the left, the control on the right.
 * Stacks on phones.
 */
export function SettingsRow({ label, description, error, children, id }: FieldProps) {
  const { controlId, describedBy } = useFieldIds(id, description, error);

  return (
    <div className="settings-row">
      <div className="settings-row-text">
        <label className="field-label" htmlFor={controlId}>
          {label}
        </label>
        {description === undefined ? null : (
          <p className="field-description" id={`${controlId}-description`}>
            {description}
          </p>
        )}
      </div>
      <div className="settings-row-control">
        {children({ id: controlId, describedBy })}
        {error === undefined ? null : (
          <p className="field-error" id={`${controlId}-error`} role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="text"
      {...props}
      className={["input", props.className].filter(Boolean).join(" ")}
    />
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={["input", props.className].filter(Boolean).join(" ")} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={["input", props.className].filter(Boolean).join(" ")} />;
}

export function Checkbox({
  label,
  description,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly ref?: Ref<HTMLInputElement>;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...props} />
      <span className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {description === undefined ? null : (
          <span className="checkbox-description">{description}</span>
        )}
      </span>
    </label>
  );
}

/** A checkbox styled as a switch; it keeps native checkbox semantics. */
export function Switch({
  label,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { readonly label?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" {...props} />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {label === undefined ? null : <span className="switch-label">{label}</span>}
    </label>
  );
}

/** Right-aligned form actions with a top divider. */
export function FormActions({ children }: { readonly children: ReactNode }) {
  return <div className="form-actions-bar">{children}</div>;
}
