import type { SQL } from "bun";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PromotionCriterionContext {
  readonly sql: SQL;
  readonly memberId: string;
  readonly now: Date;
}

/**
 * A promotion criterion contributed by a change or a plugin. `read` returns the member's
 * current value; a rule threshold is met when the value is greater than or equal to it.
 */
export interface PromotionCriterion {
  readonly key: string;
  readonly labelKey: string;
  read(context: PromotionCriterionContext): Promise<number>;
}

export class PromotionCriterionError extends Error {
  readonly code: "duplicate_criterion" | "invalid_criterion";

  constructor(code: PromotionCriterionError["code"], message: string) {
    super(message);
    this.name = "PromotionCriterionError";
    this.code = code;
  }
}

export interface PromotionCriteriaRegistry {
  register(criterion: PromotionCriterion): void;
  get(key: string): PromotionCriterion | undefined;
  list(): readonly PromotionCriterion[];
}

const CRITERION_KEY = /^[a-z][a-z0-9_]*$/;

export function createPromotionCriteriaRegistry(
  initial: readonly PromotionCriterion[] = [],
): PromotionCriteriaRegistry {
  const criteria = new Map<string, PromotionCriterion>();

  const registry: PromotionCriteriaRegistry = {
    register(criterion) {
      if (!CRITERION_KEY.test(criterion.key)) {
        throw new PromotionCriterionError(
          "invalid_criterion",
          `Promotion criterion key "${criterion.key}" is invalid`,
        );
      }

      if (criterion.labelKey.trim() === "") {
        throw new PromotionCriterionError(
          "invalid_criterion",
          `Promotion criterion "${criterion.key}" needs a label key`,
        );
      }

      if (criteria.has(criterion.key)) {
        throw new PromotionCriterionError(
          "duplicate_criterion",
          `Promotion criterion "${criterion.key}" is already registered`,
        );
      }

      criteria.set(criterion.key, criterion);
    },
    get(key) {
      return criteria.get(key);
    },
    list() {
      return [...criteria.values()];
    },
  };

  for (const criterion of initial) {
    registry.register(criterion);
  }

  return registry;
}

interface JoinedRow {
  readonly joined_at: Date | string;
}

/** The criterion this change provides; later changes register approved posts and reputation. */
export const daysSinceJoiningCriterion: PromotionCriterion = {
  key: "days_since_joining",
  labelKey: "staff.groups.promotionCriterion.daysSinceJoining",
  async read({ sql, memberId, now }) {
    const [row] = (await sql`
      SELECT joined_at
      FROM core.members
      WHERE id = ${memberId}
    `) as JoinedRow[];

    if (row === undefined) {
      return 0;
    }

    const joinedAt = row.joined_at instanceof Date ? row.joined_at : new Date(row.joined_at);
    return Math.max(0, Math.floor((now.getTime() - joinedAt.getTime()) / DAY_MS));
  },
};

/** The process-wide registry. Later changes call `registerPromotionCriterion`. */
export const promotionCriteria = createPromotionCriteriaRegistry([daysSinceJoiningCriterion]);

export function registerPromotionCriterion(criterion: PromotionCriterion): void {
  promotionCriteria.register(criterion);
}
