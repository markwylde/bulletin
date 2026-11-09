/** Only same-origin relative paths are valid post-login destinations (no open redirect). */
export function safeReturnTo(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    hasControlCharacter
  ) {
    return null;
  }

  try {
    const url = new URL(trimmed, "https://bulletin.invalid");

    if (url.origin !== "https://bulletin.invalid") {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
