/**
 * Reads one evaluated client-visible flag from the page shell (ADR 0010). Browser code uses
 * this only for client-side behaviour that has already been gated server-side; unknown or
 * malformed data fails closed.
 */
export function flagFromJson(json: string | null | undefined, key: string): boolean {
  if (json === null || json === undefined || json === "") {
    return false;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      Object.hasOwn(parsed, key) &&
      (parsed as Record<string, unknown>)[key] === true
    );
  } catch {
    return false;
  }
}

export function clientFlag(key: string): boolean {
  return flagFromJson(document.documentElement.dataset.clientFlags, key);
}
