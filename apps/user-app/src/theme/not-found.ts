import { readBoardSettings } from "@bulletin/domain/board";
import type { Locale, Translator } from "@bulletin/i18n";
import type { ViewModelContract } from "@bulletin/templates";
import type { SQL } from "bun";
import { boardNameFrom, loadActiveTheme, renderThemedPage } from "./render.ts";

export interface ThemedNotFoundInput<T> {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly route: ViewModelContract<T>;
  readonly themeId?: string | null | undefined;
}

/**
 * The themed 404 used when a feature flag turns a private page off (ADR 0010). The page is not
 * cached and its status is set by the caller.
 */
export async function renderThemedNotFound<T>(input: ThemedNotFoundInput<T>): Promise<{
  readonly html: string;
  readonly title: string;
  readonly boardName: string;
  readonly errors: readonly string[];
}> {
  const [theme, settings] = await Promise.all([
    loadActiveTheme(input.sql, input.themeId),
    readBoardSettings(input.sql),
  ]);
  const boardName = boardNameFrom(settings.boardName, input.translate);
  const page = await renderThemedPage({
    sql: input.sql,
    themeId: input.themeId,
    boardName,
    locale: input.locale,
    translate: input.translate,
    template: "error",
    viewModel: {
      code: "not_found",
      message: input.translate("theme.error.notFound"),
      flags: {},
    },
    breadcrumbs: [],
    route: input.route,
    theme,
  });

  return {
    html: page.html,
    title: input.translate("theme.error.title"),
    boardName,
    errors: page.errors,
  };
}
