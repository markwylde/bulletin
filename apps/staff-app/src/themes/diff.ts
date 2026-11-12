export type DiffKind = "same" | "add" | "remove";

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
}

/**
 * A line-level unified diff (LCS). Small on purpose: theme templates are short, and the
 * staff editor only needs to show the parent/child difference without another dependency.
 */
export function diffLines(parent: string, child: string): readonly DiffLine[] {
  const left = parent === "" ? [] : parent.split("\n");
  const right = child === "" ? [] : child.split("\n");

  // The editor only diffs a single template. Refuse a pathological matrix rather than
  // allocating hundreds of megabytes for a malformed upload.
  if (left.length > 2_000 || right.length > 2_000) {
    return [
      { kind: "remove", text: parent },
      { kind: "add", text: child },
    ];
  }

  const rows = left.length;
  const columns = right.length;
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: columns + 1 }, () => 0),
  );

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lengths[row]![column] =
        left[row] === right[column]
          ? (lengths[row + 1]![column + 1] ?? 0) + 1
          : Math.max(lengths[row + 1]![column] ?? 0, lengths[row]![column + 1] ?? 0);
    }
  }

  const diff: DiffLine[] = [];
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (left[row] === right[column]) {
      diff.push({ kind: "same", text: left[row] ?? "" });
      row += 1;
      column += 1;
    } else if ((lengths[row + 1]![column] ?? 0) >= (lengths[row]![column + 1] ?? 0)) {
      diff.push({ kind: "remove", text: left[row] ?? "" });
      row += 1;
    } else {
      diff.push({ kind: "add", text: right[column] ?? "" });
      column += 1;
    }
  }

  while (row < rows) {
    diff.push({ kind: "remove", text: left[row] ?? "" });
    row += 1;
  }

  while (column < columns) {
    diff.push({ kind: "add", text: right[column] ?? "" });
    column += 1;
  }

  return diff;
}
