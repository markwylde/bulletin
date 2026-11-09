import type { MessageValues } from "@bulletin/i18n";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useT } from "../i18n.tsx";

export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  readonly id: string;
  readonly messageKey: string;
  readonly values?: MessageValues;
  readonly tone?: ToastTone;
}

export interface ToastInput {
  readonly messageKey: string;
  readonly values?: MessageValues;
  readonly tone?: ToastTone;
  readonly durationMs?: number;
}

export interface ToastProps extends ToastItem {
  readonly onDismiss?: (id: string) => void;
}

export function Toast({ id, messageKey, values, tone = "info", onDismiss }: ToastProps) {
  const t = useT();

  return (
    <div
      className={`toast toast-${tone}`}
      data-toast
      data-toast-tone={tone}
      role={tone === "error" ? "alert" : "status"}
    >
      <p>{t(messageKey, values)}</p>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="toast-dismiss"
          aria-label={t("ui.toast.dismiss")}
          onClick={() => onDismiss(id)}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

export interface ToastRegionProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss?: (id: string) => void;
}

export function ToastRegion({ toasts, onDismiss }: ToastRegionProps) {
  return (
    <div className="toast-region" data-toast-region aria-live="polite">
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} {...(onDismiss === undefined ? {} : { onDismiss })} />
      ))}
    </div>
  );
}

export interface ToastContextValue {
  pushToast(input: ToastInput): string;
  dismissToast(id: string): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_TOAST_MS = 5_000;

export interface ToastProviderProps {
  readonly children?: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const active = timers.current;

    return () => {
      for (const timer of active.values()) {
        clearTimeout(timer);
      }
      active.clear();
    };
  }, []);

  const dismissToast = useCallback((id: string) => {
    const timer = timers.current.get(id);

    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (input: ToastInput): string => {
      const id = crypto.randomUUID();
      const toast: ToastItem = {
        id,
        messageKey: input.messageKey,
        ...(input.values === undefined ? {} : { values: input.values }),
        ...(input.tone === undefined ? {} : { tone: input.tone }),
      };
      const timer = setTimeout(() => dismissToast(id), input.durationMs ?? DEFAULT_TOAST_MS);

      timers.current.set(id, timer);
      setToasts((current) => [...current, toast]);
      return id;
    },
    [dismissToast],
  );

  const value = useMemo<ToastContextValue>(
    () => ({ pushToast, dismissToast }),
    [pushToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);

  if (value === null) {
    throw new Error("useToast must be used within a ToastProvider");
  }

  return value;
}
