/**
 * The default theme's source files (ADR 0008). The seed installs them into
 * `core.themes`/`core.theme_templates`, CI checks them, and task 8.2 keeps the DB copy in
 * sync. A theme file may be `.liquid`; themes cannot include other files.
 */

export const DEFAULT_THEME_NAME = "default";
export const DEFAULT_THEME_VERSION = 1;

export const DEFAULT_THEME_TEMPLATE_NAMES = [
  "header",
  "footer",
  "breadcrumbs",
  "empty",
  "error",
  "home",
  "forum",
  "topic",
  "post",
  "login",
  "callback",
  "demo",
  "display-name",
  "account",
  "account-profile",
  "account-attachments",
  "account-follows",
  "account-notifications",
  "account-notification-preferences",
  "account-warnings",
  "conversations",
  "conversation",
  "members",
  "online",
  "leaderboards",
  "profile",
  "moderation-queue",
  "moderation-reports",
  "moderation-report",
  "moderation-warnings",
  "moderation-log",
  "unsubscribe",
] as const;

export type DefaultThemeTemplateName = (typeof DEFAULT_THEME_TEMPLATE_NAMES)[number];

const THEMES_DIR = new URL("../themes/", import.meta.url);
const HOOKS_DIR = new URL("../hook-fragments/", import.meta.url);

function readLiquid(directory: URL, file: string): Promise<string> {
  return Bun.file(new URL(file, directory)).text();
}

/** Reads every default-theme template from the repository. */
export async function loadDefaultThemeTemplates(): Promise<Readonly<Record<string, string>>> {
  const entries = await Promise.all(
    DEFAULT_THEME_TEMPLATE_NAMES.map(async (name) => [
      name,
      await readLiquid(THEMES_DIR, `${DEFAULT_THEME_NAME}/${name}.liquid`),
    ]),
  );

  return Object.fromEntries(entries);
}

/**
 * The demo hook fragments the seed installs for the current plugin generation. They stand in
 * for a plugin's fragment until `plugin-platform` serves real ones.
 */
export async function loadDemoHookFragments(): Promise<Readonly<Record<string, string>>> {
  return {
    "demo.after.topics": await readLiquid(HOOKS_DIR, "demo.after.topics.liquid"),
  };
}
