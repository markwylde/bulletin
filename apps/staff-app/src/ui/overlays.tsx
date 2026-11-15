import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { IconClose } from "./icons.tsx";

/** Calls `onOutside` for pointer-downs outside every given element. */
export function useDismiss(
  refs: readonly RefObject<HTMLElement | null>[],
  open: boolean,
  onDismiss: () => void,
): void {
  const callback = useRef(onDismiss);
  callback.current = onDismiss;

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;

      if (target !== null && refs.some((ref) => ref.current?.contains(target))) {
        return;
      }

      callback.current();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        callback.current();
      }
    };

    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, refs]);
}

export interface MenuProps {
  /** Renders the trigger with the props it must spread. */
  readonly trigger: (props: {
    readonly "aria-expanded": boolean;
    readonly "aria-controls": string;
    readonly "aria-haspopup": "true";
    readonly onClick: () => void;
  }) => ReactNode;
  readonly children: ReactNode;
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly label: string;
}

/**
 * A popover menu. Its content stays mounted (hidden while closed) so form controls inside it
 * keep their state and hooks.
 */
export function Menu({ trigger, children, align = "end", className, label }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const refs = useRef([rootRef]).current;

  useDismiss(refs, open, () => setOpen(false));

  return (
    <div ref={rootRef} className={["menu", className].filter(Boolean).join(" ")}>
      {trigger({
        "aria-expanded": open,
        "aria-controls": id,
        "aria-haspopup": "true",
        onClick: () => setOpen((value) => !value),
      })}
      <div
        id={id}
        className={`menu-popover menu-popover-${align}`}
        role="dialog"
        aria-label={label}
        hidden={!open}
        data-menu-open={open}
      >
        {children}
      </div>
    </div>
  );
}

export function MenuSeparator() {
  return <hr className="menu-separator" />;
}

export interface DialogProps {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly closeLabel: string;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  readonly size?: "sm" | "md" | "lg";
}

/** A modal built on <dialog> for focus trapping and Escape handling. */
export function Dialog({
  open,
  title,
  description,
  onClose,
  closeLabel,
  footer,
  children,
  size = "md",
}: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;

    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a backdrop click closes; Escape is handled by onCancel
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          onClose();
        }
      }}
    >
      <div className="dialog-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description === undefined ? null : (
            <p id={descriptionId} className="dialog-description">
              {description}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <IconClose size={16} />
        </button>
      </div>
      {children === undefined ? null : <div className="dialog-body">{children}</div>}
      {footer === undefined ? null : <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}

export interface TabItem {
  readonly id: string;
  readonly label: ReactNode;
  readonly count?: number;
}

/** Underline tabs with arrow-key navigation (WAI-ARIA tabs pattern). */
export function Tabs({
  items,
  value,
  onChange,
  label,
  idPrefix,
}: {
  readonly items: readonly TabItem[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly label: string;
  /** Tab ids are `${idPrefix}-tab-${id}`; panels should use `${idPrefix}-panel-${id}`. */
  readonly idPrefix: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.id === value);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (step === 0 || index < 0) {
      return;
    }

    event.preventDefault();
    const next = items[(index + step + items.length) % items.length];

    if (next !== undefined) {
      onChange(next.id);
      document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
    }
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const selected = item.id === value;

        return (
          <button
            key={item.id}
            id={`${idPrefix}-tab-${item.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count === undefined ? null : <span className="tab-count">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
