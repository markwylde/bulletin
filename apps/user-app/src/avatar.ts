import type { AvatarVariant } from "@bulletin/storage";
import { escapeHtml } from "@bulletin/templates";

/** Stable hue for the initials fallback, derived from the member ID only (task 5.3). */
export function avatarHue(memberId: string): number {
  const digest = Bun.CryptoHasher.hash("sha256", memberId);
  const byte = digest[0] ?? 0;
  return Math.round((byte / 256) * 360);
}

export function avatarStyle(memberId: string): string {
  return `--bl-avatar-hue: ${avatarHue(memberId)}`;
}

/** Up to two initials from a display name; "Jane Doe" becomes "JD". */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2);

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function avatarUrl(memberId: string, hash: string, variant: AvatarVariant): string {
  return `/avatars/${memberId}/${hash}-${variant}.webp`;
}

/**
 * Inline initials avatar rendered by the default theme's author card: no request and a colour
 * derived from the member ID, so it is stable across pages and sessions (task 5.3).
 */
export function initialsSvg(memberId: string, name: string): string {
  const hue = avatarHue(memberId);
  const label = escapeHtml(initials(name));

  return [
    `<svg class="bl-avatar bl-avatar--initials" viewBox="0 0 40 40" width="40" height="40"`,
    ` role="img" aria-hidden="true" data-member-initials style="--bl-avatar-hue: ${hue}">`,
    '<rect class="bl-avatar__bg" width="40" height="40" rx="20"></rect>',
    `<text class="bl-avatar__text" x="20" y="25" text-anchor="middle" font-size="14" font-weight="700">${label}</text>`,
    "</svg>",
  ].join("");
}
