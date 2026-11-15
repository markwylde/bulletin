import { type ReactNode, useMemo, useState } from "react";
import { useT } from "../i18n.tsx";

export type SortDirection = "asc" | "desc";

export interface DataTableColumn<Row> {
  readonly id: string;
  readonly headerKey: string;
  readonly cell: (row: Row) => ReactNode;
  /** Required for a sortable column. */
  readonly sortValue?: (row: Row) => string | number | null;
  readonly align?: "start" | "end";
  /** In the phone card view this cell becomes the card title instead of a labelled row. */
  readonly primary?: boolean;
}

/** An `actions` column renders as an unlabelled, right-aligned button row in the card view. */
function isActionsColumn(column: { readonly id: string }): boolean {
  return column.id === "actions";
}

export interface DataTableBulkAction {
  readonly id: string;
  readonly labelKey: string;
  readonly tone?: "default" | "danger";
  readonly run: (ids: readonly string[]) => void | Promise<void>;
}

export interface DataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly DataTableColumn<Row>[];
  readonly getRowId: (row: Row) => string;
  readonly getRowLabel?: (row: Row) => string;
  readonly pageSize?: number;
  /**
   * Set false for a complete inventory that must never hide a row on a later page, such as the
   * code-declared feature flags. Pagination controls are then omitted.
   */
  readonly paginate?: boolean;
  readonly initialSort?: { readonly columnId: string; readonly direction: SortDirection };
  readonly selectable?: boolean;
  readonly selectedIds?: readonly string[];
  readonly onSelectionChange?: (ids: string[]) => void;
  readonly bulkActions?: readonly DataTableBulkAction[];
  readonly rowActions?: (row: Row) => ReactNode;
  /** Adds a class to both the table row and its card, for per-row highlights. */
  readonly rowClassName?: (row: Row) => string | undefined;
  readonly emptyKey?: string;
  readonly captionKey?: string;
}

export interface PaginatedRows<Row> {
  readonly rows: readonly Row[];
  readonly page: number;
  readonly pageCount: number;
}

interface SortState {
  readonly columnId: string;
  readonly direction: SortDirection;
}

function compareValues(left: string | number | null, right: string | number | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right);
  }

  return left < right ? -1 : 1;
}

/** Sorts by the selected column, leaving the original array untouched. */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly DataTableColumn<Row>[],
  sort: SortState,
): readonly Row[] {
  const column = columns.find((candidate) => candidate.id === sort.columnId);

  if (column?.sortValue === undefined) {
    return rows;
  }

  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort(
    (left, right) =>
      compareValues(column.sortValue?.(left) ?? null, column.sortValue?.(right) ?? null) *
      direction,
  );
}

/** Clamps the page and returns the visible slice. */
export function paginateRows<Row>(
  rows: readonly Row[],
  page: number,
  pageSize: number,
): PaginatedRows<Row> {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);

  return {
    rows: rows.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    pageCount,
  };
}

export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  getRowLabel,
  pageSize = 10,
  paginate = true,
  initialSort,
  selectable = false,
  selectedIds,
  onSelectionChange,
  bulkActions = [],
  rowActions,
  rowClassName,
  emptyKey,
  captionKey,
}: DataTableProps<Row>) {
  const t = useT();
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const [runningBulk, setRunningBulk] = useState(false);

  const sortableColumns = useMemo(
    () => columns.filter((column) => column.sortValue !== undefined),
    [columns],
  );
  const ordered = sort === null ? rows : sortRows(rows, columns, sort);
  const primaryColumn = columns.find((column) => column.primary === true);
  const actionColumns = columns.filter(isActionsColumn);
  const cardColumns = columns.filter(
    (column) => column !== primaryColumn && !isActionsColumn(column),
  );
  const pagination = paginate
    ? paginateRows(ordered, page, pageSize)
    : { rows: ordered, page: 1, pageCount: 1 };
  const pageRows = pagination.rows;
  const visibleIds = pageRows.map(getRowId);
  const selected = selectedIds ?? internalSelected;
  const allOnPageSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  const updateSelection = (ids: string[]): void => {
    if (selectedIds === undefined) {
      setInternalSelected(ids);
    }

    onSelectionChange?.(ids);
  };

  const toggleRow = (id: string): void => {
    updateSelection(
      selected.includes(id) ? selected.filter((candidate) => candidate !== id) : [...selected, id],
    );
  };

  const togglePage = (): void => {
    if (allOnPageSelected) {
      updateSelection(selected.filter((id) => !visibleIds.includes(id)));
      return;
    }

    updateSelection([...new Set([...selected, ...visibleIds])]);
  };

  const changeSort = (columnId: string): void => {
    setSort((current) => {
      if (current?.columnId === columnId) {
        return { columnId, direction: current.direction === "asc" ? "desc" : "asc" };
      }

      return { columnId, direction: "asc" };
    });
    setPage(1);
  };

  const runBulkAction = async (action: DataTableBulkAction): Promise<void> => {
    setRunningBulk(true);

    try {
      await action.run(selected);
      updateSelection([]);
    } finally {
      setRunningBulk(false);
    }
  };

  const selectedCount = selected.length;
  const cellCount = columns.length + (selectable ? 1 : 0) + (rowActions === undefined ? 0 : 1);
  const emptyMessage = emptyKey === undefined ? t("ui.table.empty") : t(emptyKey);

  return (
    <div
      className="data-table"
      data-table
      data-page={pagination.page}
      data-page-count={pagination.pageCount}
      data-selected-count={selectedCount}
    >
      <div className="data-table-toolbar">
        {sortableColumns.length > 0 ? (
          <div className="data-sort-bar">
            <label className="control">
              <span>{t("ui.table.sort")}</span>
              <select
                data-sort-select
                value={sort?.columnId ?? ""}
                onChange={(event) => {
                  if (event.target.value === "") {
                    setSort(null);
                    setPage(1);
                    return;
                  }

                  changeSort(event.target.value);
                }}
              >
                <option value="">{t("ui.table.sortNone")}</option>
                {sortableColumns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {t(column.headerKey)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="data-sort-direction"
              data-sort-direction={sort?.direction ?? "asc"}
              aria-label={
                sort?.direction === "desc" ? t("ui.table.descending") : t("ui.table.ascending")
              }
              disabled={sort === null}
              onClick={() => {
                if (sort !== null) {
                  changeSort(sort.columnId);
                }
              }}
            >
              <span aria-hidden="true">{sort?.direction === "desc" ? "↓" : "↑"}</span>
            </button>
          </div>
        ) : null}
      </div>

      {selectable && selectedCount > 0 && bulkActions.length > 0 ? (
        <section className="data-bulk-bar" data-bulk-actions aria-label={t("ui.table.bulkActions")}>
          <span>{t("ui.table.selected", { count: selectedCount })}</span>
          <div className="data-bulk-actions">
            {bulkActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className={action.tone === "danger" ? "button-danger" : undefined}
                data-bulk-action={action.id}
                disabled={runningBulk}
                onClick={() => {
                  void runBulkAction(action);
                }}
              >
                {t(action.labelKey)}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="data-table-wrap" data-table-view>
        <table>
          {captionKey === undefined ? null : <caption className="sr-only">{t(captionKey)}</caption>}
          <thead>
            <tr>
              {selectable ? (
                <th scope="col" className="data-select-cell">
                  <input
                    type="checkbox"
                    data-select-all
                    checked={allOnPageSelected}
                    aria-label={t("ui.table.selectAll")}
                    onChange={togglePage}
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const isSorted = sort?.columnId === column.id;
                const sortable = column.sortValue !== undefined;

                return (
                  <th
                    key={column.id}
                    scope="col"
                    className={column.align === "end" ? "align-end" : undefined}
                    {...(sortable
                      ? {
                          "aria-sort": isSorted
                            ? sort?.direction === "asc"
                              ? "ascending"
                              : "descending"
                            : "none",
                        }
                      : {})}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        className="data-sort-button"
                        data-sort-column={column.id}
                        aria-label={t("ui.table.sortBy", { column: t(column.headerKey) })}
                        onClick={() => changeSort(column.id)}
                      >
                        {t(column.headerKey)}
                      </button>
                    ) : (
                      t(column.headerKey)
                    )}
                  </th>
                );
              })}
              {rowActions === undefined ? null : (
                <th scope="col" className="align-end">
                  {t("ui.table.actions")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={cellCount} data-table-empty>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageRows.map((row) => {
                const id = getRowId(row);

                return (
                  <tr key={id} className={rowClassName?.(row)} data-table-row={id}>
                    {selectable ? (
                      <td className="data-select-cell">
                        <input
                          type="checkbox"
                          data-row-select={id}
                          checked={selected.includes(id)}
                          aria-label={t("ui.table.selectRowLabel", {
                            row: getRowLabel?.(row) ?? id,
                          })}
                          onChange={() => toggleRow(id)}
                        />
                      </td>
                    ) : null}
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={column.align === "end" ? "align-end" : undefined}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                    {rowActions === undefined ? null : (
                      <td className="align-end data-row-actions">{rowActions(row)}</td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <ul className="data-cards" data-card-view>
        {pageRows.length === 0 ? (
          <li className="data-card data-card-empty" data-table-empty>
            {emptyMessage}
          </li>
        ) : (
          pageRows.map((row) => {
            const id = getRowId(row);

            return (
              <li
                key={id}
                className={
                  rowClassName?.(row) === undefined ? "data-card" : `data-card ${rowClassName(row)}`
                }
                data-card-row={id}
              >
                <div className="data-card-head">
                  {selectable ? (
                    <input
                      type="checkbox"
                      data-card-select={id}
                      checked={selected.includes(id)}
                      aria-label={t("ui.table.selectRowLabel", {
                        row: getRowLabel?.(row) ?? id,
                      })}
                      onChange={() => toggleRow(id)}
                    />
                  ) : null}
                  {primaryColumn !== undefined ? (
                    <span className="data-card-title">{primaryColumn.cell(row)}</span>
                  ) : getRowLabel === undefined ? null : (
                    <span className="data-card-title">{getRowLabel(row)}</span>
                  )}
                </div>
                <dl className="data-card-cells">
                  {cardColumns.map((column) => (
                    <div
                      key={column.id}
                      className={
                        column.align === "end" ? "data-card-cell align-end" : "data-card-cell"
                      }
                    >
                      <dt>{t(column.headerKey)}</dt>
                      <dd>{column.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
                {actionColumns.map((column) => (
                  <div key={column.id} className="data-card-actions">
                    {column.cell(row)}
                  </div>
                ))}
                {rowActions === undefined ? null : (
                  <div className="data-card-actions">{rowActions(row)}</div>
                )}
              </li>
            );
          })
        )}
      </ul>

      {paginate ? (
        <div className="data-pagination">
          <button
            type="button"
            data-page-previous
            disabled={pagination.page <= 1}
            aria-label={t("ui.table.previous")}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <span aria-hidden="true">←</span>
          </button>
          <span data-page-label>
            {t("ui.table.page", { page: pagination.page, pages: pagination.pageCount })}
          </span>
          <button
            type="button"
            data-page-next
            disabled={pagination.page >= pagination.pageCount}
            aria-label={t("ui.table.next")}
            onClick={() => setPage((current) => Math.min(pagination.pageCount, current + 1))}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
