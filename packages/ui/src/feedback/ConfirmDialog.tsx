import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n.tsx";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly confirmLabelKey?: string;
  readonly cancelLabelKey?: string;
  readonly tone?: "default" | "danger";
  /** External busy state, for example while the request is in flight. */
  readonly busy?: boolean;
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  titleKey,
  bodyKey,
  confirmLabelKey,
  cancelLabelKey,
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [working, setWorking] = useState(false);
  const isBusy = busy || working;

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") {
        dialog.showModal();
      } else {
        dialog.open = true;
      }
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.open = false;
      }
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      data-confirm-dialog
      data-confirm-tone={tone}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      onCancel={(event) => {
        event.preventDefault();
        if (!isBusy) {
          onCancel();
        }
      }}
    >
      <h2 id={titleId}>{t(titleKey)}</h2>
      <p id={bodyId}>{t(bodyKey)}</p>
      <div className="dialog-actions">
        <button type="button" className="dialog-cancel" disabled={isBusy} onClick={onCancel}>
          {cancelLabelKey === undefined ? t("ui.dialog.cancel") : t(cancelLabelKey)}
        </button>
        <button
          type="button"
          className={tone === "danger" ? "button-danger" : undefined}
          disabled={isBusy}
          data-confirm-action
          onClick={() => {
            if (isBusy) {
              return;
            }

            setWorking(true);
            void Promise.resolve(onConfirm()).finally(() => setWorking(false));
          }}
        >
          {isBusy
            ? t("ui.dialog.working")
            : confirmLabelKey === undefined
              ? t("ui.dialog.confirm")
              : t(confirmLabelKey)}
        </button>
      </div>
    </dialog>
  );
}
