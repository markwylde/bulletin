import type { Root } from "hast";
import { visit } from "unist-util-visit";
import type { ReplaceWords } from "./types.ts";

/**
 * Pipeline rules change only with a code release; filter edits add their own version.
 * Version 2 marks embed players with `data-bl-embed` so the theme renderer can keep them
 * while still rejecting every theme-authored iframe (ADR 0007, 0008). Version 3 marks mention
 * links with `data-mention` so reads can unwrap them for viewers without the flag (ADR 0010).
 */
export const BASE_RENDER_VERSION = 3;
export const SANITISER_VERSION = 1;

/**
 * `render_version` is ordered: the code pipeline version dominates, the replace-word list
 * version is the low part. Bumping it makes the re-render job pick old rows up (ADR 0007).
 */
export function renderVersionFor(replaceWords?: ReplaceWords): number {
  return BASE_RENDER_VERSION * 1_000_000 + (replaceWords?.version ?? 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacer(rules: readonly ReplaceWords["rules"][number][]): (value: string) => string {
  if (rules.length === 0) {
    return (value) => value;
  }

  const pattern = new RegExp(rules.map((rule) => escapeRegExp(rule.word)).join("|"), "giu");
  const byWord = new Map(rules.map((rule) => [rule.word.toLowerCase(), rule.replacement]));

  return (value) => value.replace(pattern, (match) => byWord.get(match.toLowerCase()) ?? match);
}

/** Applies replace words to HAST text nodes only; `body_md` is never touched (ADR 0007). */
export function transformReplaceWords(tree: Root, replaceWords?: ReplaceWords): void {
  if (replaceWords === undefined || replaceWords.rules.length === 0) {
    return;
  }

  const replace = replacer(replaceWords.rules);

  visit(tree, "text", (node) => {
    node.value = replace(node.value);
  });
}
