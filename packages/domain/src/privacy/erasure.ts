import type { SQL } from "bun";

/** Categories kept after erasure with a documented basis (ADR 0012). */
export interface RetainedCategory {
  readonly key: string;
  readonly basisKey: string;
}

export interface ErasureRequestResult {
  readonly requestId: string;
  readonly retained: readonly RetainedCategory[];
}

/**
 * The member-facing confirmation. The categories are policy statements; an active ban is
 * added only when the member actually has one.
 */
export async function retainedErasureCategories(
  sql: SQL,
  memberId: string,
): Promise<readonly RetainedCategory[]> {
  const activeBans = (await sql`
    SELECT 1 FROM core.member_bans
    WHERE member_id = ${memberId}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as unknown[];

  return [
    {
      key: "dataRequests",
      basisKey: "privacy.erasure.retained.dataRequests",
    },
    {
      key: "accessLog",
      basisKey: "privacy.erasure.retained.accessLog",
    },
    {
      key: "moderationLog",
      basisKey: "privacy.erasure.retained.moderationLog",
    },
    {
      key: "warnings",
      basisKey: "privacy.erasure.retained.warnings",
    },
    ...(activeBans.length === 0 ? [] : [{ key: "ban", basisKey: "privacy.erasure.retained.ban" }]),
  ];
}

/** Creates the erasure request and returns the retained-record notice in one transaction. */
export async function requestDataErasure(
  sql: SQL,
  sessionToken: string,
  memberId: string,
): Promise<ErasureRequestResult | null> {
  if (!/^\d+$/.test(memberId)) {
    return null;
  }

  return sql.begin(async (tx) => {
    const [row] = (await tx`
      SELECT pii.create_data_request(${sessionToken}, 'erasure') AS id
    `) as Array<{ id: string | null }>;
    const requestId = row?.id;

    if (requestId === null || requestId === undefined || !/^\d+$/.test(requestId)) {
      return null;
    }

    return {
      requestId,
      retained: await retainedErasureCategories(tx, memberId),
    };
  });
}
