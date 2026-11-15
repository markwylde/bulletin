import { useT } from "@bulletin/ui";
import { ConfirmDialog } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useState } from "react";
import { Button, Page, Panel } from "../ui/index.ts";

interface SampleRow {
  readonly id: string;
  readonly name: string;
  readonly posts: number;
  readonly active: boolean;
}

const SAMPLE_ROWS: readonly SampleRow[] = [
  { id: "1", name: "Delta", posts: 42, active: true },
  { id: "2", name: "Alpha", posts: 7, active: false },
  { id: "3", name: "Echo", posts: 128, active: true },
  { id: "4", name: "Bravo", posts: 19, active: false },
  { id: "5", name: "Charlie", posts: 63, active: true },
];

const DEMO_FORM: FormDefinition = {
  id: "dev-form",
  submitLabelKey: "staff.dev.forms.submit",
  sections: [
    {
      id: "main",
      titleKey: "staff.dev.forms.title",
      fields: [
        {
          id: "count",
          type: "number",
          labelKey: "staff.dev.forms.number",
          min: 0,
          max: 10,
          required: true,
        },
      ],
    },
  ],
};

/** Development-only screen for checking the shared building blocks at every viewport. */
export function BlocksPage() {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [activeRow, setActiveRow] = useState<SampleRow | null>(null);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({ count: 0 });
  const [submitCount, setSubmitCount] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  const columns: readonly DataTableColumn<SampleRow>[] = [
    {
      id: "name",
      headerKey: "staff.dev.blocks.name",
      cell: (row) => row.name,
      sortValue: (row) => row.name,
    },
    {
      id: "posts",
      headerKey: "staff.dev.blocks.posts",
      cell: (row) => row.posts,
      sortValue: (row) => row.posts,
      align: "end",
    },
    {
      id: "status",
      headerKey: "staff.dev.blocks.status",
      cell: (row) =>
        row.active ? t("staff.dev.blocks.status.active") : t("staff.dev.blocks.status.idle"),
    },
  ];

  return (
    <Page
      id="dev-blocks"
      title={t("staff.dev.blocks.title")}
      description={t("staff.dev.blocks.intro")}
    >
      <Panel flush>
        <DataTable
          rows={SAMPLE_ROWS}
          columns={columns}
          getRowId={(row) => row.id}
          getRowLabel={(row) => row.name}
          pageSize={2}
          selectable
          selectedIds={selected}
          onSelectionChange={setSelected}
          bulkActions={[
            {
              id: "archive",
              labelKey: "staff.dev.blocks.archive",
              run: (ids) => setArchivedCount(ids.length),
            },
          ]}
          rowActions={(row) => (
            <Button size="sm" data-row-action={row.id} onClick={() => setActiveRow(row)}>
              {t("staff.dev.blocks.view")}
            </Button>
          )}
        />
      </Panel>

      <p className="subtle" data-active-row={activeRow?.id ?? "none"}>
        {activeRow === null
          ? t("staff.dev.blocks.none")
          : t("staff.dev.blocks.selected", { name: activeRow.name })}
      </p>
      {archivedCount === null ? null : (
        <p className="subtle" data-last-bulk={archivedCount}>
          {t("staff.dev.blocks.archived", { count: archivedCount })}
        </p>
      )}

      <section className="stack" data-dev-form>
        <FormRenderer
          definition={DEMO_FORM}
          values={formValues}
          onChange={setFormValues}
          onSubmit={() => setSubmitCount((count) => count + 1)}
        />
        <p className="subtle" data-submit-count={submitCount}>
          {t("staff.dev.forms.submitted", { count: submitCount })}
        </p>
      </section>

      <Panel data-dev-dialog>
        <Button data-open-dialog onClick={() => setDialogOpen(true)}>
          {t("staff.dev.dialog.open")}
        </Button>
        <ConfirmDialog
          open={dialogOpen}
          titleKey="staff.dev.dialog.title"
          bodyKey="staff.dev.dialog.body"
          onConfirm={() => setDialogOpen(false)}
          onCancel={() => setDialogOpen(false)}
        />
      </Panel>
    </Page>
  );
}
