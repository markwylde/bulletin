/// <reference types="astro/client" />

import type { BoardSettings } from "@bulletin/domain/board";

declare global {
  namespace App {
    interface Locals {
      cspNonce: string;
      locale?: "en" | "es" | "fr";
      localeSource?: "member" | "guest";
      board?: BoardSettings;
    }
  }
}
