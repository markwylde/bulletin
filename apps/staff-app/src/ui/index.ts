/**
 * The staff UI kit (ADR 0021). Pages compose these; styles live in `src/styles/kit.css`.
 * Shared `@bulletin/ui` pieces (DataTable, ConfirmDialog, Toast, FormRenderer) are styled by
 * the same stylesheet and re-exported here so pages import from one place.
 */
export { ConfirmDialog, ToastProvider, useToast } from "@bulletin/ui/feedback";
export { FormRenderer } from "@bulletin/ui/forms";
export { DataTable } from "@bulletin/ui/table";
export * from "./Button.tsx";
export * from "./forms.tsx";
export * from "./icons.tsx";
export * from "./layout.tsx";
export * from "./overlays.tsx";
export * from "./Table.tsx";
