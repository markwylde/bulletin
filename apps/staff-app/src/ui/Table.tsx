import type { HTMLAttributes, ReactNode } from "react";

export interface TableColumn<Row> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: "start" | "end";
  /** Shown as the row title on phones instead of a labelled cell. */
  readonly primary?: boolean;
  readonly width?: string;
}

export interface TableProps<Row> {
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly empty?: ReactNode;
  readonly caption?: string;
  readonly rowProps?: (
    row: Row,
  ) => HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string>;
}

/**
 * A data table. On phones each row stacks into a block whose cells carry their header as a
 * label, so nothing scrolls sideways (ADR 0014).
 */
export function Table<Row>({ columns, rows, rowKey, empty, caption, rowProps }: TableProps<Row>) {
  return (
    <div className="table-wrap">
      <table className="table">
        {caption === undefined ? null : <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={column.align === "end" ? "align-end" : undefined}
                style={column.width === undefined ? undefined : { width: column.width }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="table-empty-row">
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} {...rowProps?.(row)}>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    data-label={column.primary ? undefined : column.header}
                    className={
                      [
                        column.align === "end" ? "align-end" : null,
                        column.primary ? "cell-primary" : null,
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
