import { isStaffScheme, type StaffScheme } from "@bulletin/domain/permissions";
import { isLocale, type Locale } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router";
import { apiPost } from "../api.ts";
import { sectionElement } from "../section-routes.tsx";
import {
  canAccessSection,
  STAFF_SECTIONS,
  type StaffIcon,
  type StaffSection,
  visibleSections,
} from "../sections.ts";
import { useSession } from "../session.tsx";

function SectionIcon({ icon }: { readonly icon: StaffIcon }) {
  switch (icon) {
    case "dashboard":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z" />
        </svg>
      );
  }
}

function SectionRoute({ section }: { readonly section: StaffSection }) {
  const t = useT();
  const { permissions } = useSession();

  if (!canAccessSection(permissions, section)) {
    return (
      <div className="state-page" data-access-denied="section">
        <h1>{t("staff.sectionDenied.title")}</h1>
        <p>{t("staff.sectionDenied.body")}</p>
      </div>
    );
  }

  const Section = sectionElement(section);

  if (Section === null) {
    return <NotFoundPage />;
  }

  return <Section />;
}

function NotFoundPage() {
  const t = useT();

  return (
    <div className="state-page" data-not-found>
      <h1>{t("staff.notFound.title")}</h1>
      <p>{t("staff.notFound.body")}</p>
    </div>
  );
}

function Navigation({
  sections,
  open,
  onNavigate,
}: {
  readonly sections: readonly StaffSection[];
  readonly open: boolean;
  readonly onNavigate: () => void;
}) {
  const t = useT();

  return (
    <nav
      id="staff-navigation"
      className="staff-nav"
      data-nav
      data-open={open}
      aria-label={t("staff.nav.label")}
    >
      <ul>
        {sections.map((section) => (
          <li key={section.id}>
            <NavLink
              to={section.path}
              end={section.path === "/"}
              className={({ isActive }) => (isActive ? "nav-link nav-link-active" : "nav-link")}
              onClick={onNavigate}
            >
              <SectionIcon icon={section.icon} />
              <span>{t(section.labelKey)}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Controls({ scheme, locale }: { readonly scheme: StaffScheme; readonly locale: Locale }) {
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
    <div className="staff-controls">
      <label className="control">
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

      <label className="control">
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

      <button
        type="button"
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
        {t("auth.logout")}
      </button>

      {schemeSave.isError ? <p data-scheme-error>{t("staff.scheme.error")}</p> : null}
      {localeSave.isError ? <p data-locale-error>{t("staff.locale.error")}</p> : null}
      {logoutFailed ? <p data-logout-error>{t("auth.logoutError")}</p> : null}
    </div>
  );
}

export function Shell() {
  const t = useT();
  const locale = useLocale();
  const { state } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const scheme = state.status === "authenticated" ? (state.session.scheme ?? "system") : "system";

  useEffect(() => {
    document.documentElement.dataset.scheme = scheme;
    localStorage.setItem("bulletin_staff_scheme", scheme);
  }, [scheme]);

  if (state.status !== "authenticated") {
    return null;
  }

  const session = state.session;
  const sections = visibleSections(session.permissions);

  return (
    <div className="staff-shell" data-nav-open={navOpen} data-auth-state="authenticated">
      <header className="staff-header">
        <div className="staff-header-main">
          <button
            type="button"
            className="menu-button"
            data-menu-toggle
            aria-controls="staff-navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <span className="sr-only">{t("staff.nav.menu")}</span>
            <span aria-hidden="true" className="menu-icon" />
          </button>
          <span className="staff-brand">{t("staff.brand")}</span>
          <span className="staff-user" data-signed-in>
            {t("auth.signedIn")} {session.displayName ?? ""}
          </span>
        </div>

        <Controls scheme={scheme} locale={locale} />
      </header>

      <Navigation sections={sections} open={navOpen} onNavigate={() => setNavOpen(false)} />

      <main className="staff-main">
        <Routes>
          {STAFF_SECTIONS.map((section) => (
            <Route
              key={section.id}
              path={section.path}
              element={<SectionRoute section={section} />}
            />
          ))}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
