import {
  deleteRank,
  listRanks,
  type RankInput,
  type RankRecord,
  saveRank,
} from "@bulletin/domain/ranks";
import type { Locale } from "@bulletin/i18n";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

const LOCALES: readonly Locale[] = ["en", "es", "fr"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labels(value: unknown): Readonly<Record<Locale, string>> | null {
  if (!isRecord(value)) {
    return null;
  }

  const result: Partial<Record<Locale, string>> = {};

  for (const locale of LOCALES) {
    const text = value[locale];

    if (typeof text !== "string" || text.trim() === "") {
      return null;
    }

    result[locale] = text.trim();
  }

  return result as Readonly<Record<Locale, string>>;
}

export function parseRankInput(value: unknown): RankInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const titleLabels = labels(value.titleLabels);
  const minPosts = value.minPosts;
  const pips = value.pips ?? 0;
  const imageKey =
    typeof value.imageKey === "string" && value.imageKey.trim() !== ""
      ? value.imageKey.trim()
      : null;

  if (
    titleLabels === null ||
    typeof minPosts !== "number" ||
    !Number.isSafeInteger(minPosts) ||
    minPosts < 0 ||
    typeof pips !== "number" ||
    !Number.isSafeInteger(pips) ||
    pips < 0 ||
    pips > 20
  ) {
    return null;
  }

  const id =
    typeof value.id === "string" && /^\d+$/.test(value.id)
      ? value.id
      : value.id === undefined
        ? null
        : undefined;

  if (id === undefined) {
    return null;
  }

  return { id, minPosts, titleLabels, pips, imageKey };
}

export async function listRanksForStaff(sql: SQL): Promise<readonly RankRecord[]> {
  return listRanks(sql);
}

export async function mutateRank(
  sql: SQL,
  actorId: string,
  body: unknown,
): Promise<
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly code: string }
> {
  if (!isRecord(body) || typeof body.action !== "string") {
    return { ok: false, code: "invalid" };
  }

  if (body.action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    const removed = await deleteRank(sql, id);

    if (!removed) {
      return { ok: false, code: "not_found" };
    }

    await writeAdminLog(sql, {
      actorMemberId: actorId,
      action: "rank.delete",
      targetType: "rank",
      targetId: id,
      summary: { id },
    });

    return { ok: true, id };
  }

  if (body.action !== "save") {
    return { ok: false, code: "invalid" };
  }

  const parsed = parseRankInput(body.rank);

  if (parsed === null) {
    return { ok: false, code: "invalid" };
  }

  const id = await saveRank(sql, parsed);

  await writeAdminLog(sql, {
    actorMemberId: actorId,
    action: parsed.id === null ? "rank.create" : "rank.update",
    targetType: "rank",
    targetId: id,
    summary: { minPosts: parsed.minPosts, pips: parsed.pips },
  });

  return { ok: true, id };
}
