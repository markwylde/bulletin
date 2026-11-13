import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../i18n/en.json";
import { I18nProvider } from "../i18n.tsx";
import { DataTable, type DataTableColumn, paginateRows, sortRows } from "./DataTable.tsx";

interface Row {
  readonly id: string;
  readonly name: string;
  readonly posts: number;
}

const rows: readonly Row[] = [
  { id: "a", name: "Alpha", posts: 3 },
  { id: "b", name: "Bravo", posts: 10 },
  { id: "c", name: "Charlie", posts: 1 },
];

const columns: readonly DataTableColumn<Row>[] = [
  { id: "name", headerKey: "test.name", cell: (row) => row.name, sortValue: (row) => row.name },
  {
    id: "posts",
    headerKey: "test.posts",
    cell: (row) => row.posts,
    sortValue: (row) => row.posts,
    align: "end",
  },
];

const messages = {
  ...en,
  "test.name": "Name",
  "test.posts": "Posts",
};

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={messages}>
      {node}
    </I18nProvider>,
  );
}

describe("data table pure helpers", () => {
  test("sorts ascending and descending by a column", () => {
    expect(
      sortRows(rows, columns, { columnId: "posts", direction: "asc" }).map((row) => row.id),
    ).toEqual(["c", "a", "b"]);
    expect(
      sortRows(rows, columns, { columnId: "posts", direction: "desc" }).map((row) => row.id),
    ).toEqual(["b", "a", "c"]);
  });

  test("keeps the original order for an unknown or unsortable column", () => {
    expect(sortRows(rows, columns, { columnId: "missing", direction: "asc" })).toBe(rows);
  });

  test("clamps the page and slices rows", () => {
    expect(paginateRows(rows, 1, 2)).toMatchObject({ page: 1, pageCount: 2 });
    expect(paginateRows(rows, 1, 2).rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(paginateRows(rows, 9, 2).rows.map((row) => row.id)).toEqual(["c"]);
    expect(paginateRows(rows, 0, 2).page).toBe(1);
  });
});

describe("data table component", () => {
  test("renders a table and a card view for the current page", () => {
    const markup = render(
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        pageSize={2}
      />,
    );

    expect(markup).toContain('data-page="1"');
    expect(markup).toContain('data-page-count="2"');
    expect(markup).toContain("data-card-view");
    expect(markup).toContain('data-card-row="a"');
    expect(markup).toContain('data-card-row="b"');
    expect(markup).not.toContain('data-card-row="c"');
    expect(markup).toContain("Page 1 of 2");
  });

  test("renders sort controls and selection with bulk actions", () => {
    const markup = render(
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        selectable
        selectedIds={["a"]}
        bulkActions={[
          {
            id: "archive",
            labelKey: "test.archive",
            run: () => undefined,
          },
        ]}
        rowActions={(row) => <button type="button">{`Edit ${row.name}`}</button>}
      />,
    );

    expect(markup).toContain("data-sort-select");
    expect(markup).toContain("No sorting");
    expect(markup).toContain("data-select-all");
    expect(markup).toContain("data-bulk-actions");
    expect(markup).toContain("1 selected");
    expect(markup).toContain('data-bulk-action="archive"');
    expect(markup).toContain("Edit Alpha");
  });

  test("renders an unpaginated inventory in full, with no page controls", () => {
    const markup = render(
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        pageSize={2}
        paginate={false}
      />,
    );

    expect(markup).toContain('data-card-row="a"');
    expect(markup).toContain('data-card-row="c"');
    expect(markup).toContain('data-page-count="1"');
    expect(markup).not.toContain("data-page-next");
    expect(markup).not.toContain("data-page-label");
  });

  test("renders the empty state with a translated message", () => {
    const markup = render(
      <DataTable
        rows={[]}
        columns={columns}
        getRowId={(row) => row.id}
        emptyKey="ui.table.empty"
      />,
    );

    expect(markup).toContain("No rows to show.");
  });

  test("marks highlighted rows in both the table and the card list", () => {
    const markup = render(
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        rowClassName={(row) => (row.id === "a" ? "row-stale" : undefined)}
      />,
    );

    expect(markup).toContain('class="row-stale"');
    expect(markup).toContain('class="data-card row-stale"');
    expect(markup).toContain("data-table-view");
  });
});
