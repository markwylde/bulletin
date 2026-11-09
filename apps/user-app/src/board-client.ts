import {
  catalogEntry,
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  localeFromBpCookie,
} from "@bulletin/i18n";
import { USER_CATALOGS } from "./catalogs.ts";

export interface BoardState {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: string;
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly canViewOffline: boolean;
}

interface BoardClientWindow extends Window {
  __bulletinApplyLocale?: (locale: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFor(locale: string, key: string): string {
  const resolved: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return catalogEntry(USER_CATALOGS[resolved], key) ?? catalogEntry(USER_CATALOGS.en, key) ?? key;
}

function boardStateFrom(value: unknown): BoardState | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.boardName !== "string" ||
    typeof value.boardDescription !== "string" ||
    typeof value.defaultLocale !== "string" ||
    typeof value.offline !== "boolean" ||
    typeof value.offlineMessage !== "string" ||
    typeof value.canViewOffline !== "boolean"
  ) {
    return null;
  }

  return {
    boardName: value.boardName,
    boardDescription: value.boardDescription,
    defaultLocale: value.defaultLocale,
    offline: value.offline,
    offlineMessage: value.offlineMessage,
    canViewOffline: value.canViewOffline,
  };
}

/** Fetches the public board state; any transport, status or shape failure is a closed gate. */
export async function fetchBoardState(fetcher: typeof fetch = fetch): Promise<BoardState | null> {
  try {
    const response = await fetcher("/api/board", {
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      return null;
    }

    return boardStateFrom(await response.json().catch(() => null));
  } catch {
    return null;
  }
}

/** Unknown state is treated as blocked, as is an offline board without permission. */
export function shouldBlockBoard(state: BoardState | null): boolean {
  return state === null || (state.offline && !state.canViewOffline);
}

function currentLocation(doc: Document): { pathname: string; search: string } {
  const location = doc.defaultView?.location;
  return {
    pathname: location?.pathname ?? "/",
    search: location?.search ?? "",
  };
}

function show(
  online: Element | null,
  offline: Element | null,
  blocked: boolean,
  reason: "offline" | "unavailable" | null,
): void {
  if (online instanceof HTMLElement) {
    online.hidden = blocked;
  }

  if (offline instanceof HTMLElement) {
    offline.hidden = !blocked;

    if (blocked && reason !== null) {
      offline.dataset.offlineReason = reason;
    } else {
      delete offline.dataset.offlineReason;
    }
  }
}

/**
 * Applies the board state to the static shell. The online screen is hidden until the
 * server-authoritative `/api/board` response confirms access.
 */
export function applyBoardState(doc: Document, state: BoardState | null): void {
  const online = doc.querySelector("[data-online]");
  const offline = doc.querySelector("[data-offline]");
  const offlineMessage = doc.querySelector("[data-offline-message]");
  const offlineLogin = doc.querySelector("[data-offline-login]");
  const locale = doc.documentElement.lang;
  const location = currentLocation(doc);

  if (offlineLogin instanceof HTMLAnchorElement) {
    offlineLogin.href = `/auth/login?return_to=${encodeURIComponent(
      `${location.pathname}${location.search}`,
    )}`;
  }

  if (state === null) {
    show(online, offline, true, "unavailable");

    if (offlineMessage !== null) {
      offlineMessage.textContent = messageFor(locale, "board.offline.defaultMessage");
    }

    return;
  }

  if (state !== null) {
    const title = doc.querySelector("[data-board-name]");

    if (title instanceof HTMLElement) {
      if (state.boardName.trim() !== "") {
        doc.title = state.boardName;
        title.textContent = state.boardName;
        title.dataset.boardConfigured = "";
      } else {
        delete title.dataset.boardConfigured;
        title.textContent = messageFor(locale, "user.placeholder.title");
      }
    }

    const description = doc.querySelector("[data-board-description]");

    if (description instanceof HTMLElement) {
      if (state.boardDescription.trim() !== "") {
        description.textContent = state.boardDescription;
        description.dataset.boardConfigured = "";
      } else {
        delete description.dataset.boardConfigured;
        description.textContent = messageFor(locale, "user.placeholder.body");
      }
    }
  }

  const blocked = shouldBlockBoard(state);

  if (!blocked) {
    show(online, offline, false, null);
    return;
  }

  show(online, offline, true, "offline");

  if (offlineMessage !== null) {
    offlineMessage.textContent =
      state.offlineMessage.trim() !== ""
        ? state.offlineMessage
        : messageFor(locale, "board.offline.defaultMessage");
  }
}

/** Guests without a query/cookie locale fall back to the board default. */
export function applyBoardDefaultLocale(doc: Document, state: BoardState): void {
  if (doc.documentElement.dataset.localeSource === "member") {
    return;
  }

  const location = doc.defaultView?.location;
  const params = new URLSearchParams(location?.search ?? "");
  const bp = /(?:^|;\s*)bp=([^;]+)/.exec(doc.cookie)?.[1];
  const requested = params.get("lang");
  const hasRequestedLocale = requested !== null && isLocale(requested);
  const hasCookieLocale = localeFromBpCookie(bp) !== null;

  if (hasRequestedLocale || hasCookieLocale || !isLocale(state.defaultLocale)) {
    return;
  }

  if (state.defaultLocale !== doc.documentElement.lang) {
    (doc.defaultView as BoardClientWindow | null)?.__bulletinApplyLocale?.(state.defaultLocale);
  }
}
