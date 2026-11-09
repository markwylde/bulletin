/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    cspNonce: string;
    locale?: "en" | "es" | "fr";
    localeSource?: "member" | "guest";
  }
}
