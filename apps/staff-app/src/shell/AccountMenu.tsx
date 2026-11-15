import { isStaffScheme, type StaffScheme } from "@bulletin/domain/permissions";
import { isLocale, type Locale } from "@bulletin/i18n";
import { useT } from "@bulletin/ui";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { apiPost } from "../api.ts";
import { useSession } from "../session.tsx";
import { IconChevronDown, IconLogOut } from "../ui/icons.tsx";
import { Menu, MenuSeparator } from "../ui/overlays.tsx";

export function initials(name: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) {
    return "?";
  }

  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";

  return `${first}${last}`.toUpperCase();
}

/** Name, colour mode, language and sign-out: everything personal lives here, not in the bar. */
export function AccountMenu({
  displayName,
  scheme,
  locale,
}: {
  readonly displayName: string | null;
  readonly scheme: StaffScheme;
  readonly locale: Locale;
}) {
  const t = useT();
  const { signOut, updateLocale, updateScheme } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const schemeSave = useMutation({
    mutationFn: (next: StaffScheme) =>
      apiPost<{ scheme: StaffScheme }>("/api/staff/preferences/scheme", { scheme: next }),
    onSuccess: (data) => updateScheme(data.scheme),
  });
  const localeSave = useMutation({
    mutationFn: (next: Locale) => apiPost<{ locale: Locale }>("/api/me/locale", { locale: next }),
    onSuccess: (data) => updateLocale(data.locale),
  });

  return (
    <Menu
      label={t("staff.account.menu")}
      className="account"
      trigger={(props) => (
        <button type="button" className="account-trigger" data-account-menu {...props}>
          <span className="avatar" aria-hidden="true">
            {initials(displayName)}
          </span>
          <span className="account-trigger-name">{displayName ?? ""}</span>
          <IconChevronDown size={14} className="account-trigger-chevron" />
          <span className="sr-only">{t("staff.account.menu")}</span>
        </button>
      )}
    >
      <div className="account-head">
        <span className="avatar avatar-lg" aria-hidden="true">
          {initials(displayName)}
        </span>
        <div className="account-head-text">
          <p className="account-name" data-signed-in>
            {displayName ?? ""}
          </p>
          <p className="account-role">{t("auth.signedIn")}</p>
        </div>
      </div>

      <MenuSeparator />

      <div className="menu-fields">
        <label className="menu-field">
          <span>{t("staff.scheme.label")}</span>
          <select
            data-scheme-switch
            value={scheme}
            onChange={(event) => {
              if (isStaffScheme(event.target.value)) {
                schemeSave.mutate(event.target.value);
              }
            }}
          >
            <option value="system">{t("staff.scheme.system")}</option>
            <option value="light">{t("staff.scheme.light")}</option>
            <option value="dark">{t("staff.scheme.dark")}</option>
          </select>
        </label>
        <label className="menu-field">
          <span>{t("staff.locale.label")}</span>
          <select
            data-locale-switch
            value={locale}
            onChange={(event) => {
              if (isLocale(event.target.value)) {
                localeSave.mutate(event.target.value);
              }
            }}
          >
            <option value="en">{t("staff.locale.en")}</option>
            <option value="es">{t("staff.locale.es")}</option>
            <option value="fr">{t("staff.locale.fr")}</option>
          </select>
        </label>
        {schemeSave.isError ? (
          <p className="menu-error" data-scheme-error role="alert">
            {t("staff.scheme.error")}
          </p>
        ) : null}
        {localeSave.isError ? (
          <p className="menu-error" data-locale-error role="alert">
            {t("staff.locale.error")}
          </p>
        ) : null}
      </div>

      <MenuSeparator />

      <button
        type="button"
        className="menu-item"
        data-logout
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          void signOut().then((ok) => {
            if (!ok) {
              setSigningOut(false);
              setLogoutFailed(true);
            }
          });
        }}
      >
        <IconLogOut size={16} />
        <span>{t("auth.logout")}</span>
      </button>
      {logoutFailed ? (
        <p className="menu-error" data-logout-error role="alert">
          {t("auth.logoutError")}
        </p>
      ) : null}
    </Menu>
  );
}
