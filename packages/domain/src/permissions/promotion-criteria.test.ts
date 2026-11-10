import { describe, expect, test } from "bun:test";
import {
  createPromotionCriteriaRegistry,
  daysSinceJoiningCriterion,
  PromotionCriterionError,
  promotionCriteria,
} from "./promotion-criteria.ts";

describe("promotion criteria registry", () => {
  test("ships the days-since-joining criterion this change provides", () => {
    expect(promotionCriteria.get("days_since_joining")).toBe(daysSinceJoiningCriterion);
    expect(daysSinceJoiningCriterion.labelKey).toBe(
      "staff.groups.promotionCriterion.daysSinceJoining",
    );
  });

  test("later changes can register additional criteria", () => {
    const registry = createPromotionCriteriaRegistry([daysSinceJoiningCriterion]);
    const approvedPosts = {
      key: "approved_posts",
      labelKey: "test.promotionCriteria.approvedPosts",
      read: async () => 12,
    };

    registry.register(approvedPosts);

    expect(registry.get("approved_posts")).toBe(approvedPosts);
    expect(registry.list()).toEqual([daysSinceJoiningCriterion, approvedPosts]);
  });

  test("rejects duplicate and invalid criteria", () => {
    const registry = createPromotionCriteriaRegistry([daysSinceJoiningCriterion]);
    const valid = {
      key: "reputation",
      labelKey: "test.promotionCriteria.reputation",
      read: async () => 1,
    };

    registry.register(valid);

    expect(() => registry.register(valid)).toThrow(PromotionCriterionError);
    expect(() => registry.register({ ...valid, key: "Bad Key" })).toThrow(PromotionCriterionError);
    expect(() => registry.register({ ...valid, key: "empty_label", labelKey: "  " })).toThrow(
      PromotionCriterionError,
    );
  });
});
