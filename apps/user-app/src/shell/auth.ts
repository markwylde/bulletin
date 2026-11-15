import {
  beginLogin,
  clearStashedRequest,
  createAuthFetch,
  loadSession,
  logout,
  ReauthRequiredError,
  reauthUrl,
  SessionRevokedError,
  takeStashedRequest,
} from "@bulletin/domain/auth/browser";
import { clearLocalMemberData, rememberMember, sessionRevoked } from "../auth/client.ts";
import { resumeStashedRequest } from "../resume.ts";
import { showMember } from "./member.ts";

/**
 * The header's sign-in and member menu on every page (ADR 0021). The header HTML is shared by
 * every viewer with the same capabilities (ADR 0006), so the signed-in state is applied here.
 *
 * Guests (no session cookie, `data-visitor="guest"`) never call the session API outside the
 * board index, so CDN-cached guest pages stay free of per-request API calls. The board index
 * keeps its original behaviour: it always loads the session, applies the member's locale and
 * sends a stale session to re-authenticate.
 */

const root = document.documentElement;
const isBoardIndex = document.querySelector("[data-board-index]") !== null;
const isLoginPage = document.querySelector("[data-login-page]") !== null;

const area = document.querySelector<HTMLElement>("[data-shell-header] [data-auth]");
const loginButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-shell-header] [data-login]"),
];
const logoutButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-logout]")];
const signedIn = [...document.querySelectorAll<HTMLElement>("[data-signed-in]")];
const authErrors = [
  ...document.querySelectorAll<HTMLElement>("[data-shell-header] [data-auth-error]"),
];
const logoutError = document.querySelector<HTMLElement>("[data-logout-error]");
const reauthBox = document.querySelector<HTMLElement>("[data-reauth]");
const continueButton = document.querySelector<HTMLButtonElement>("[data-reauth-continue]");
const resumeButton = document.querySelector<HTMLButtonElement>("[data-resume]");

let currentMemberId: string | null = null;
// Read lazily: the board index's locale bootstrap may run after this module.
const applyLocale = (locale: string): void => {
  (
    window as unknown as { __bulletinApplyLocale?: (locale: string) => void }
  ).__bulletinApplyLocale?.(locale);
};

function setState(state: "loading" | "guest" | "authenticated" | "error"): void {
  area?.setAttribute("data-auth-state", state);
  root.dataset.session = state;
}

function showGuest(): void {
  setState("guest");

  for (const button of loginButtons) {
    button.hidden = false;
  }

  for (const element of signedIn) {
    element.hidden = true;
  }
}

function showError(): void {
  for (const element of authErrors) {
    element.hidden = false;
  }
}

function updateReauthPrompt(authenticated: boolean): void {
  const stashed = takeStashedRequest(currentMemberId);

  if (reauthBox !== null) {
    reauthBox.hidden = stashed === null;
  }

  if (resumeButton !== null) {
    resumeButton.hidden = !(authenticated && stashed !== null);
  }
}

const authFetch = createAuthFetch({
  ownerId: () => currentMemberId,
  onReauthRequired: () => {
    updateReauthPrompt(false);
  },
  onSessionRevoked: () => {
    sessionRevoked();
  },
});

async function refresh(): Promise<void> {
  try {
    const session = await loadSession();
    currentMemberId = session.authenticated ? (session.memberId ?? null) : null;

    if (isBoardIndex) {
      rememberMember(currentMemberId ?? "");
    }

    if (!session.authenticated) {
      showGuest();
      updateReauthPrompt(false);
      return;
    }

    if (isBoardIndex) {
      root.dataset.localeSource = "member";

      if (session.locale !== null) {
        root.dataset.serverLocale = session.locale;
        applyLocale(session.locale);
      }
    }

    setState("authenticated");

    for (const button of loginButtons) {
      button.hidden = true;
    }

    for (const element of signedIn) {
      element.hidden = false;
    }

    showMember(session.displayName ?? "", session.memberId ?? "");
    updateReauthPrompt(true);
  } catch (error) {
    if (isBoardIndex && error instanceof ReauthRequiredError) {
      window.location.assign(reauthUrl(`${window.location.pathname}${window.location.search}`));
      return;
    }

    if (isBoardIndex && error instanceof SessionRevokedError) {
      sessionRevoked();
      return;
    }

    if (isBoardIndex) {
      setState("error");
      showError();

      for (const button of loginButtons) {
        button.hidden = false;
      }

      return;
    }

    // Elsewhere a failed session read only affects the header: show the sign-in button.
    showGuest();
  }
}

for (const button of loginButtons) {
  button.addEventListener("click", () => {
    button.disabled = true;
    // From the sign-in page itself, return to where that page was going to send the member.
    const returnTo = isLoginPage
      ? (new URLSearchParams(window.location.search).get("return_to") ?? "/")
      : undefined;

    void beginLogin(returnTo === undefined ? {} : { returnTo }).catch(() => {
      showError();
      button.disabled = false;
    });
  });
}

for (const button of logoutButtons) {
  button.addEventListener("click", () => {
    button.disabled = true;
    void logout({ clearLocalData: clearLocalMemberData }).then((ok) => {
      if (!ok) {
        if (logoutError !== null) {
          logoutError.hidden = false;
        }

        button.disabled = false;
      }
    });
  });
}

continueButton?.addEventListener("click", () => {
  window.location.assign(reauthUrl(`${window.location.pathname}${window.location.search}`));
});

if (resumeButton !== null) {
  resumeButton.addEventListener("click", () => {
    resumeButton.disabled = true;
    void resumeStashedRequest({
      take: () => takeStashedRequest(currentMemberId),
      clear: () => clearStashedRequest(),
      fetch: authFetch,
    })
      .then((result) => {
        if (result === "success") {
          window.location.reload();
        }
      })
      .finally(() => {
        resumeButton.disabled = false;
        updateReauthPrompt(true);
      });
  });
}

if (isBoardIndex && new URLSearchParams(window.location.search).has("auth_error")) {
  showError();
}

if (root.dataset.visitor === "member" || isBoardIndex) {
  void refresh();
} else {
  showGuest();
}
