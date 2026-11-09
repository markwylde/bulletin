import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../i18n/en.json";
import { I18nProvider } from "../i18n.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Toast, ToastRegion } from "./Toast.tsx";

const messages = {
  ...en,
  "test.dialog.body": "This action cannot be undone.",
  "test.dialog.cancel": "Keep it",
  "test.dialog.confirm": "Archive",
  "test.dialog.title": "Archive this row?",
  "test.toast.first": "Saved successfully.",
  "test.toast.second": "Could not save.",
};

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={messages}>
      {node}
    </I18nProvider>,
  );
}

describe("confirmation dialog", () => {
  test("renders the open dialog with translated copy and a danger tone", () => {
    const markup = render(
      <ConfirmDialog
        open
        titleKey="test.dialog.title"
        bodyKey="test.dialog.body"
        tone="danger"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("data-confirm-dialog");
    expect(markup).toContain('data-confirm-tone="danger"');
    expect(markup).toContain("Archive this row?");
    expect(markup).toContain("This action cannot be undone.");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Confirm");
    expect(markup).toContain("button-danger");
  });

  test("uses custom labels and shows a busy state", () => {
    const markup = render(
      <ConfirmDialog
        open
        titleKey="test.dialog.title"
        bodyKey="test.dialog.body"
        confirmLabelKey="test.dialog.confirm"
        cancelLabelKey="test.dialog.cancel"
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain("Archive");
    expect(markup).toContain("Keep it");
    expect(markup).toContain("Working…");
    expect(markup).toContain("data-confirm-action");
    expect(markup).toContain("disabled");
  });

  test("renders nothing while closed", () => {
    const markup = render(
      <ConfirmDialog
        open={false}
        titleKey="test.dialog.title"
        bodyKey="test.dialog.body"
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("toasts", () => {
  test("renders a region with tones and dismiss controls", () => {
    const markup = render(
      <ToastRegion
        toasts={[
          { id: "1", messageKey: "test.toast.first", tone: "success" },
          { id: "2", messageKey: "test.toast.second", tone: "error" },
        ]}
        onDismiss={() => undefined}
      />,
    );

    expect(markup).toContain("data-toast-region");
    expect(markup).toContain('data-toast-tone="success"');
    expect(markup).toContain('data-toast-tone="error"');
    expect(markup).toContain("Saved successfully.");
    expect(markup).toContain("Could not save.");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Dismiss notification");
  });

  test("renders a standalone toast without a dismiss control", () => {
    const markup = render(<Toast id="1" messageKey="test.toast.first" />);

    expect(markup).toContain('data-toast-tone="info"');
    expect(markup).toContain("Saved successfully.");
    expect(markup).not.toContain("toast-dismiss");
  });
});
