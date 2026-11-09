import ts from "typescript";

/** JSX props whose literal values are read by people. */
export const USER_FACING_PROPS = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "label",
  "placeholder",
  "title",
]);

export interface HardCodedString {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly kind: "text" | "attribute";
  readonly prop?: string;
}

function readable(value: string): boolean {
  const stripped = value
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /\p{L}{2}/u.test(stripped);
}

function literalText(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) {
    return undefined;
  }

  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }

  return undefined;
}

/**
 * Finds untranslated JSX text and literal values on user-facing props. Astro files are handled
 * by their own check once templates render through `{% t %}`.
 */
export function findHardCodedStrings(
  source: string,
  file = "component.tsx",
): readonly HardCodedString[] {
  const scriptKind =
    file.endsWith(".jsx") || file.endsWith(".js") ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const found: HardCodedString[] = [];

  const report = (
    node: ts.Node,
    text: string,
    kind: HardCodedString["kind"],
    prop?: string,
  ): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    found.push({
      file,
      line: position.line + 1,
      column: position.character + 1,
      text,
      kind,
      ...(prop === undefined ? {} : { prop }),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && readable(node.text)) {
      report(node, node.text.trim(), "text");
    }

    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : undefined;
      const value = node.initializer;

      if (name !== undefined && USER_FACING_PROPS.has(name) && value !== undefined) {
        const text = ts.isStringLiteral(value)
          ? value.text
          : ts.isJsxExpression(value)
            ? literalText(value.expression)
            : undefined;

        if (text !== undefined && text.trim().length > 0) {
          report(value, text, "attribute", name);
        }
      }
    }

    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      const text = literalText(node.expression);

      if (text !== undefined && readable(text)) {
        report(node, text, "text");
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return found;
}

export function formatHardCodedString(finding: HardCodedString): string {
  const where = finding.prop === undefined ? "text" : `"${finding.prop}" attribute`;
  return `${finding.file}:${finding.line}:${finding.column}: hard-coded ${where}: "${finding.text}"`;
}
