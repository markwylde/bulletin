import type { Root as HastRoot } from "hast";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { ContentProfile, SourceContext } from "./types.ts";
import { ContentError } from "./types.ts";

export const SAVE_STAGE_PHASES = ["plugin_transform", "core_check", "plugin_veto"] as const;
export type SaveStagePhase = (typeof SAVE_STAGE_PHASES)[number];

const PHASE_ORDER: Record<SaveStagePhase, number> = {
  plugin_transform: 0,
  core_check: 1,
  plugin_veto: 2,
};

export interface SaveCheckContext {
  readonly profile: ContentProfile;
  readonly context: SourceContext;
  readonly authorId: string;
  /** Supplied by `moderation` once the board's filter list exists. */
  readonly blockedWords?: readonly string[];
  /** Supplied by `moderation` once link limits are configurable. */
  readonly maxLinks?: number;
}

export interface BeforeSaveStage {
  readonly name: string;
  readonly phase: SaveStagePhase;
  /** Transforms return new markdown; checks throw a `ContentError` to veto the save. */
  run(content: string, context: SaveCheckContext): Promise<string> | string;
}

export interface BeforeSaveRegistry {
  readonly stages: readonly BeforeSaveStage[];
  run(content: string, context: SaveCheckContext): Promise<string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Counts anchors on the HAST so autolinks and raw HTML anchors are included too. */
function countLinks(content: string): number {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw);
  const tree = processor.runSync(processor.parse(content)) as HastRoot;
  let count = 0;

  visit(tree, "element", (node) => {
    if (node.tagName === "a") {
      count += 1;
    }
  });

  return count;
}

/** Block words are checked before persistence (ADR 0007). */
export const badWordsStage: BeforeSaveStage = {
  name: "bad-words",
  phase: "core_check",
  run(content, context) {
    const words = context.blockedWords ?? [];

    if (words.length === 0) {
      return content;
    }

    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(${words.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
      "iu",
    );

    if (pattern.test(content)) {
      throw new ContentError("blocked_word", "Content contains a blocked word");
    }

    return content;
  },
};

/** The accurate count runs over the parsed markdown, never a regex (ADR 0007). */
export const linkLimitStage: BeforeSaveStage = {
  name: "link-limits",
  phase: "core_check",
  run(content, context) {
    if (context.maxLinks === undefined) {
      return content;
    }

    if (countLinks(content) > context.maxLinks) {
      throw new ContentError(
        "too_many_links",
        `Content may contain at most ${context.maxLinks} links`,
      );
    }

    return content;
  },
};

/** Hook point for the anti-spam rules that arrive with `moderation`. */
export const spamStage: BeforeSaveStage = {
  name: "spam",
  phase: "core_check",
  run(content) {
    return content;
  },
};

export function defaultBeforeSaveStages(): readonly BeforeSaveStage[] {
  return [badWordsStage, linkLimitStage, spamStage];
}

/**
 * Registers `beforeSave` stages in their fixed order: plugin transforms, then the core
 * checks, then plugin veto filters. Sanitising happens after this in `renderContent`, so a
 * plugin can never add content after the core checks have passed (ADR 0007).
 */
export function createBeforeSaveRegistry(
  stages: readonly BeforeSaveStage[] = defaultBeforeSaveStages(),
): BeforeSaveRegistry {
  const indexed = stages.map((stage, index) => ({ stage, index }));
  indexed.sort(
    (left, right) =>
      PHASE_ORDER[left.stage.phase] - PHASE_ORDER[right.stage.phase] || left.index - right.index,
  );

  const ordered = indexed.map((entry) => entry.stage);

  return {
    stages: ordered,
    async run(content, context) {
      let current = content;

      for (const stage of ordered) {
        if (stage.phase === "plugin_transform") {
          current = await stage.run(current, context);
        } else {
          // Checks and vetoes may inspect but never rewrite the content.
          await stage.run(current, context);
        }
      }

      return current;
    },
  };
}
