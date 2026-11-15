import type { ReactNode } from "react";
import { Button, Field, Panel, TextInput } from "../ui/index.ts";

type DataAttributes = Record<`data-${string}`, string | boolean>;

/** The "find a member by ID" bar at the top of the member tools. */
export function MemberLookup({
  label,
  loadLabel,
  value,
  onChange,
  onLoad,
  inputProps,
  buttonProps,
  children,
}: {
  readonly label: string;
  readonly loadLabel: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called with the trimmed ID, or null when it is not a number. */
  readonly onLoad: (id: string | null) => void;
  readonly inputProps: DataAttributes;
  readonly buttonProps: DataAttributes;
  readonly children?: ReactNode;
}) {
  const valid = /^\d+$/.test(value.trim());

  return (
    <Panel>
      <form
        className="toolbar-filters"
        onSubmit={(event) => {
          event.preventDefault();
          onLoad(valid ? value.trim() : null);
        }}
      >
        <Field label={label}>
          {({ id }) => (
            <TextInput
              id={id}
              inputMode="numeric"
              autoComplete="off"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              {...inputProps}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" {...buttonProps}>
          {loadLabel}
        </Button>
        {children}
      </form>
    </Panel>
  );
}
