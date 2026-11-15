import {
  clickSelector,
  loginAs,
  setInputValue,
  waitForSelector,
  withPage,
} from "@bulletin/test-utils/e2e";
import { staffBaseUrl } from "@bulletin/test-utils/urls";

/**
 * Changes one Members-group setting through the real staff screen.
 *
 * Fixtures need deterministic limits (several replies in a row, more conversations than a
 * day's quota), while the E2E stack keeps its database between runs. Callers restore the
 * seeded value in a finally block (or `afterAll`) so the suite stays rerunnable.
 */
export async function setMembersGroupSetting(key: string, value: number): Promise<void> {
  const cell = `[data-setting-cell="members:${key}"]`;
  const save = "[data-settings-save]";

  await withPage(
    { url: `${staffBaseUrl()}/groups/settings?group=members`, viewport: "mobile360" },
    async (view) => {
      await loginAs(view, "admin");
      await waitForSelector(view, '[data-page="group-settings"]', 20_000);
      await waitForSelector(view, cell, 20_000);

      if (
        (await view.evaluate<string>(`document.querySelector(${JSON.stringify(cell)}).value`)) ===
        String(value)
      ) {
        return;
      }

      await setInputValue(view, cell, String(value));
      await waitForSelector(view, `${save}:not([disabled])`, 20_000);
      await clickSelector(view, save);
      await waitForSelector(view, '[data-toast-tone="success"]', 20_000);
    },
  );
}

export const SEEDED_FLOOD_SECONDS = 15;
export const SEEDED_PM_DAILY_STARTS = 20;

export function setPostingFloodSeconds(seconds: number): Promise<void> {
  return setMembersGroupSetting("posting.flood_control_seconds", seconds);
}

/** Restores the seeded value, tolerating a stack that has already gone away. */
export function restorePostingFlood(): Promise<void> {
  return setPostingFloodSeconds(SEEDED_FLOOD_SECONDS).catch(() => undefined);
}

export function setPmDailyStarts(limit: number): Promise<void> {
  return setMembersGroupSetting("posting.pm_daily_starts", limit);
}

/** Restores the seeded value, tolerating a stack that has already gone away. */
export function restorePmDailyStarts(): Promise<void> {
  return setPmDailyStarts(SEEDED_PM_DAILY_STARTS).catch(() => undefined);
}
