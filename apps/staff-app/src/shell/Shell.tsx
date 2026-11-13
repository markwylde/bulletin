import { isStaffScheme, type StaffScheme } from "@bulletin/domain/permissions";
import { isLocale, type Locale } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router";
import { apiGet, apiPost } from "../api.ts";
import { BlocksPage } from "../dev/BlocksPage.tsx";
import { sectionElement } from "../section-routes.tsx";
import {
  canAccessSection,
  type StaffIcon,
  type StaffSection,
  sectionsWithFlags,
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
    case "flags":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M5 3h2v18H5zM8 4h10l-2 4 2 4H8z" />
        </svg>
      );
    case "events":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 4-2.1-.7-.6-1.4 1-2-1.8-1.8-2 1-1.4-.6L13.4 4h-2.8l-.7 2.1-1.4.6-2-1L4.7 7.5l1 2-.6 1.4L3 12v2.8l2.1.7.6 1.4-1 2 1.8 1.8 2-1 1.4.6.7 2.1h2.8l.7-2.1 1.4-.6 2 1 1.8-1.8-1-2 .6-1.4L21 14z" />
        </svg>
      );
    case "strings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 5h16v2H4zM4 9h10v2H4zM4 13h16v2H4zM4 17h12v2H4z" />
        </svg>
      );
    case "log":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 5h16v2H4zM4 9h16v2H4zM4 13h16v2H4zM4 17h16v2H4z" />
        </svg>
      );
    case "groups":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5v1H2zm12 1v-1c0-2-1-3.6-2.5-4.6 1-.3 2-.4 2.5-.4 3 0 6 2 6 5v1z" />
        </svg>
      );
    case "permissions":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6zm0 4 1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4L6.2 10l4-.6z" />
        </svg>
      );
    case "members":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 22c0-4 3.6-6 8-6s8 2 8 6z" />
        </svg>
      );
    case "moderators":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 3h10l-2 4 2 4H4zm0 0h2v18H4zm12 8 4 9h-2l-4-9z" />
        </svg>
      );
    case "promotions":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 3 6 11h4v4h4v-4h4zM5 18h14v2H5z" />
        </svg>
      );
    case "themes":
    case "plugins":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M4 4h7v7H4zm9 0h7v4h-7zM4 13h7v7H4zm9-3h7v10h-7z" />
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
              data-section={section.id}
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
  const features = useQuery({
    queryKey: ["staff", "features"],
    queryFn: () => apiGet<{ flags: Record<string, boolean> }>("/api/staff/features"),
    enabled: state.status === "authenticated",
  });

  useEffect(() => {
    document.documentElement.dataset.scheme = scheme;
    localStorage.setItem("bulletin_staff_scheme", scheme);
  }, [scheme]);

  if (state.status !== "authenticated") {
    return null;
  }

  const session = state.session;
  const sections = sectionsWithFlags(
    visibleSections(session.permissions),
    features.data?.flags ?? {},
  );

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
          {sections.map((section) => (
            <Route
              key={section.id}
              path={section.path}
              element={<SectionRoute section={section} />}
            />
          ))}
          {import.meta.env.DEV ? <Route path="/dev/blocks" element={<BlocksPage />} /> : null}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
