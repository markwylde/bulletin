import { useT } from "@bulletin/ui";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useState } from "react";

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

/** Development-only screen for checking the shared building blocks at every viewport. */
export function BlocksPage() {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [activeRow, setActiveRow] = useState<SampleRow | null>(null);
  const [archivedCount, setArchivedCount] = useState<number | null>(null);

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
    <div className="page" data-page="dev-blocks">
      <header className="page-header">
        <h1>{t("staff.dev.blocks.title")}</h1>
        <p>{t("staff.dev.blocks.intro")}</p>
      </header>

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
          <button type="button" data-row-action={row.id} onClick={() => setActiveRow(row)}>
            {t("staff.dev.blocks.view")}
          </button>
        )}
      />

      <p data-active-row={activeRow?.id ?? "none"}>
        {activeRow === null
          ? t("staff.dev.blocks.none")
          : t("staff.dev.blocks.selected", { name: activeRow.name })}
      </p>
      {archivedCount === null ? null : (
        <p data-last-bulk={archivedCount}>
          {t("staff.dev.blocks.archived", { count: archivedCount })}
        </p>
      )}
    </div>
  );
}
