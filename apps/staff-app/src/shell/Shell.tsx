import { useLocale, useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation } from "react-router";
import { apiGet } from "../api.ts";
import { BlocksPage } from "../dev/BlocksPage.tsx";
import { sectionElement } from "../section-routes.tsx";
import {
  canAccessSection,
  navigationAreas,
  type StaffArea,
  type StaffSection,
  sectionForPath,
  sectionsWithFlags,
  visibleSections,
} from "../sections.ts";
import { useSession } from "../session.tsx";
import { IconExternal, IconMenu, IconSearch } from "../ui/icons.tsx";
import { Breadcrumbs, type Crumb, EmptyState } from "../ui/layout.tsx";
import { AccountMenu } from "./AccountMenu.tsx";
import { CommandPalette, useCommandShortcut } from "./CommandPalette.tsx";
import { Navigation, useNavLayout } from "./navigation.tsx";

const PANEL_STORAGE_KEY = "bulletin_staff_panel";

/** The public board lives on the user origin: the staff host without its `staff.` label. */
export function userSiteUrl(origin: string): string {
  try {
    const url = new URL(origin);

    if (url.hostname.startsWith("staff.")) {
      url.hostname = url.hostname.slice("staff.".length);
    }

    return `${url.origin}/`;
  } catch {
    return "/";
  }
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. Key names are not translated. */
function shortcutLabel(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;

  return /mac|iphone|ipad/i.test(platform) ? "⌘K" : "Ctrl K";
}

function readPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(PANEL_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function SectionRoute({ section }: { readonly section: StaffSection }) {
  const t = useT();
  const { permissions } = useSession();

  if (!canAccessSection(permissions, section)) {
    return (
      <div className="state-page" data-access-denied="section">
        <EmptyState
          title={t("staff.sectionDenied.title")}
          description={t("staff.sectionDenied.body")}
        />
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
      <EmptyState title={t("staff.notFound.title")} description={t("staff.notFound.body")} />
    </div>
  );
}

function ShellBreadcrumbs({
  section,
  home,
  areaLabelKey,
  exact,
}: {
  readonly section: StaffSection;
  readonly home: StaffSection | undefined;
  readonly areaLabelKey: string;
  readonly exact: boolean;
}) {
  const t = useT();

  if (section.id === "dashboard") {
    return null;
  }

  const items: Crumb[] = [
    home === undefined || home.id === section.id
      ? { label: t(areaLabelKey) }
      : { label: t(areaLabelKey), to: home.path },
    exact ? { label: t(section.labelKey) } : { label: t(section.labelKey), to: section.path },
  ];

  // An area whose home is this section reads "Area" then "Section"; the area is not a link.
  return <Breadcrumbs items={items} label={t("staff.breadcrumbs")} />;
}

export function Shell() {
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
  const layout = useNavLayout();
  const { state } = useSession();
  const [navOpen, setNavOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(readPanelCollapsed);
  const [commandOpen, setCommandOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<StaffArea | null>(null);
  const scheme = state.status === "authenticated" ? (state.session.scheme ?? "system") : "system";
  const features = useQuery({
    queryKey: ["staff", "features"],
    queryFn: () => apiGet<{ flags: Record<string, boolean> }>("/api/staff/features"),
    enabled: state.status === "authenticated",
  });
  const permissions = state.status === "authenticated" ? state.session.permissions : [];
  const flags = features.data?.flags;
  const sections = useMemo(
    () => sectionsWithFlags(visibleSections(permissions), flags ?? {}),
    [permissions, flags],
  );
  const areas = useMemo(() => navigationAreas(sections), [sections]);
  const currentSection = sectionForPath(sections, location.pathname);
  const currentArea = areas.find((view) => view.area.id === currentSection?.area);

  useCommandShortcut(() => setCommandOpen(true));

  useEffect(() => {
    document.documentElement.dataset.scheme = scheme;
    localStorage.setItem("bulletin_staff_scheme", scheme);
  }, [scheme]);

  // The panel follows the page: after navigating, it shows the current section's area.
  useEffect(() => {
    setSelectedArea(currentSection?.area ?? null);
  }, [currentSection?.area]);

  useEffect(() => {
    const brand = t("staff.console");
    document.title =
      currentSection === undefined ? brand : `${t(currentSection.labelKey)} · ${brand}`;
  }, [currentSection, t]);

  useEffect(() => {
    if (layout === "desktop") {
      setNavOpen(false);
    }
  }, [layout]);

  if (state.status !== "authenticated") {
    return null;
  }

  const session = state.session;
  const togglePanel = () => {
    setPanelCollapsed((collapsed) => {
      const next = !collapsed;

      try {
        localStorage.setItem(PANEL_STORAGE_KEY, next ? "collapsed" : "open");
      } catch {
        // Storage can be unavailable; the panel state is a convenience only.
      }

      return next;
    });
  };

  return (
    <div
      className="shell"
      data-auth-state="authenticated"
      data-nav-open={navOpen}
      data-layout={layout}
      data-panel-collapsed={layout === "desktop" && panelCollapsed}
    >
      <a className="skip-link" href="#main">
        {t("staff.skipToContent")}
      </a>

      <Navigation
        areas={areas}
        selectedArea={selectedArea}
        currentSection={currentSection}
        open={navOpen}
        layout={layout}
        panelCollapsed={layout === "desktop" && panelCollapsed}
        onSelectArea={setSelectedArea}
        onOpenChange={(open) => {
          setNavOpen(open);

          if (!open) {
            setSelectedArea(currentSection?.area ?? null);
          }
        }}
        onTogglePanel={togglePanel}
      />

      {navOpen ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is a pointer convenience; Escape and the close button also dismiss
        // biome-ignore lint/a11y/useKeyWithClickEvents: see above
        <div className="nav-backdrop" onClick={() => setNavOpen(false)} />
      ) : null}

      <div className="shell-body">
        <header className="topbar">
          <button
            type="button"
            className="btn btn-ghost btn-icon topbar-menu"
            data-menu-toggle
            aria-controls="staff-navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((open) => !open)}
          >
            <IconMenu size={20} />
            <span className="sr-only">{t("staff.nav.menu")}</span>
          </button>

          <span className="topbar-brand">
            {t("staff.brand")}
            <span className="topbar-brand-tag">{t("staff.consoleTag")}</span>
          </span>

          <button
            type="button"
            className="search-trigger"
            data-command-open
            aria-haspopup="dialog"
            onClick={() => setCommandOpen(true)}
          >
            <IconSearch size={16} />
            <span className="search-trigger-label">{t("staff.search.placeholder")}</span>
            <span className="search-trigger-kbd" aria-hidden="true">
              {shortcutLabel()}
            </span>
            <span className="sr-only">{t("staff.search.label")}</span>
          </button>

          <div className="topbar-actions">
            <a
              className="btn btn-ghost topbar-site"
              href={userSiteUrl(window.location.origin)}
              data-view-site
            >
              <IconExternal size={16} />
              <span className="topbar-site-label">{t("staff.viewSite")}</span>
            </a>
            <AccountMenu displayName={session.displayName} scheme={scheme} locale={locale} />
          </div>
        </header>

        <main id="main" className="content" tabIndex={-1}>
          <div className="content-inner">
            {currentSection === undefined || currentArea === undefined ? null : (
              <ShellBreadcrumbs
                section={currentSection}
                home={currentArea.home}
                areaLabelKey={currentArea.area.labelKey}
                exact={currentSection.path === (location.pathname.replace(/\/+$/, "") || "/")}
              />
            )}
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
          </div>
        </main>
      </div>

      <CommandPalette areas={areas} open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}
