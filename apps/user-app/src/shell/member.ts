/** Up to two initials from a display name, matching the server's author-card fallback. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2);

  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

/** The same stable hue the server derives from the member ID (`apps/user-app/src/avatar.ts`). */
export async function avatarHue(memberId: string): Promise<number | null> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(memberId));
    const byte = new Uint8Array(digest)[0] ?? 0;
    return Math.round((byte / 256) * 360);
  } catch {
    return null;
  }
}

/** Fills the member's name, initials avatar and profile link into the shared header. */
export function showMember(displayName: string, memberId: string): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-display-name]")) {
    element.textContent = displayName;
  }

  for (const avatar of document.querySelectorAll<HTMLElement>("[data-header-avatar]")) {
    avatar.textContent = initialsOf(displayName);

    if (memberId !== "") {
      void avatarHue(memberId).then((hue) => {
        if (hue !== null) {
          avatar.style.setProperty("--bl-avatar-hue", String(hue));
        }
      });
    }
  }

  if (memberId !== "") {
    for (const link of document.querySelectorAll<HTMLAnchorElement>(
      "[data-account-profile-link]",
    )) {
      link.href = `/profile/${encodeURIComponent(memberId)}`;
    }
  }
}
