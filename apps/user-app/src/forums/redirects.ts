import type { SQL } from "bun";

/**
 * Appends one redirect-forum click to the UNLOGGED buffer (ADR 0006 read-path writes). A failed
 * counter write must never block the redirect itself.
 */
export async function recordRedirectClick(sql: SQL, forumId: string): Promise<void> {
  try {
    await sql`
      INSERT INTO core.forum_redirect_clicks (forum_id)
      VALUES (${forumId})
    `;
  } catch (error) {
    console.warn("[forums] could not record a redirect click", error);
  }
}
