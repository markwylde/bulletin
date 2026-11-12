/// <reference types="astro/client" />

import type { BoardSettings } from "@bulletin/domain/board";
import type { UserAppSessionContext } from "./session.ts";

declare global {
  namespace App {
    interface Locals {
      cspNonce: string;
      locale?: "en" | "es" | "fr";
      localeSource?: "member" | "guest";
      board?: BoardSettings;
      session?: UserAppSessionContext | null;
      /** The preview or guest-chosen theme; null means the bundled default. */
      themeId?: string | null;
      previewTheme?: boolean;
      colourScheme?: import("@bulletin/i18n").ColorScheme;
      themeCookieScheme?: import("@bulletin/i18n").ColorScheme;
      resetThemeCookie?: string;
    }
  }
}
