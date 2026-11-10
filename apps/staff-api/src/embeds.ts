import {
  deleteEmbedProvider,
  listEmbedProviders,
  saveEmbedProvider,
} from "@bulletin/domain/content";
import type { SQL } from "bun";
import { writeAdminLog } from "./admin-log.ts";

export type EmbedMutation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "invalid" | "not_found";
      readonly fields?: readonly string[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listEmbedProvidersForStaff(sql: SQL) {
  return { providers: await listEmbedProviders(sql, { includeDisabled: true }) };
}

/** Admin save/delete; each change is audited and applies to every future render. */
export async function mutateEmbedProvider(
  sql: SQL,
  actorMemberId: string,
  body: unknown,
): Promise<EmbedMutation> {
  if (!isRecord(body)) {
    return { ok: false, code: "invalid_request" };
  }

  if (body.action === "save") {
    const result = await saveEmbedProvider(sql, body.provider);

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        ...(result.fields === undefined ? {} : { fields: result.fields }),
      };
    }

    if (result.provider !== undefined) {
      await writeAdminLog(sql, {
        actorMemberId,
        action: "embed.provider.save",
        targetType: "embed_provider",
        targetId: result.provider.key,
        summary: {
          key: result.provider.key,
          title: result.provider.title,
          enabled: result.provider.enabled,
        },
      });
    }

    return { ok: true };
  }

  if (body.action === "delete") {
    const key = typeof body.key === "string" ? body.key : "";
    const result = await deleteEmbedProvider(sql, key);

    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        ...(result.fields === undefined ? {} : { fields: result.fields }),
      };
    }

    await writeAdminLog(sql, {
      actorMemberId,
      action: "embed.provider.delete",
      targetType: "embed_provider",
      targetId: key,
      summary: { key },
    });

    return { ok: true };
  }

  return { ok: false, code: "invalid_request" };
}
