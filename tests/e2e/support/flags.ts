import { loginAs, withPage } from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

/**
 * Replaces one feature flag's rules through the real staff API, then restores it in the
 * caller's `finally`. Seeded flags default on with no rules, so `[]` restores them.
 */
export async function setFlagRules(key: string, rules: readonly unknown[]): Promise<void> {
  await withPage({ url: staffBaseUrl(), viewport: "desktop" }, async (view) => {
    await loginAs(view, "admin");
    const saved = await view.evaluate<boolean>(`(async () => {
      const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json());
      const response = await fetch("/api/staff/flags", {
        method: "POST",
        headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
        body: JSON.stringify({ key: ${JSON.stringify(key)}, rules: ${JSON.stringify(rules)} })
      });
      return response.ok;
    })()`);

    if (!saved) {
      throw new Error(`Could not update the ${key} flag`);
    }
  });
}
