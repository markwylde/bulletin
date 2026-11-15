import { useT } from "@bulletin/ui";
import { type ComponentType, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import type { StaffArea, StaffAreaView, StaffSection } from "../sections.ts";
import {
  IconBrush,
  IconChevronLeft,
  IconClose,
  IconForums,
  IconHome,
  IconLock,
  IconPanel,
  IconPlug,
  IconSettings,
  IconShield,
  IconUsers,
} from "../ui/icons.tsx";

export const AREA_ICONS: Readonly<Record<StaffArea, ComponentType<{ size?: number }>>> = {
  overview: IconHome,
  members: IconUsers,
  content: IconForums,
  moderation: IconShield,
  appearance: IconBrush,
  integrations: IconPlug,
  privacy: IconLock,
  system: IconSettings,
};

export type NavLayout = "phone" | "tablet" | "desktop";

const TABLET = "(min-width: 768px)";
const DESKTOP = "(min-width: 1024px)";

function currentLayout(): NavLayout {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "desktop";
  }

  if (window.matchMedia(DESKTOP).matches) {
    return "desktop";
  }

  return window.matchMedia(TABLET).matches ? "tablet" : "phone";
}

/** Phone: one drawer. Tablet: rail plus a flyout panel. Desktop: rail plus a docked panel. */
export function useNavLayout(): NavLayout {
  const [layout, setLayout] = useState<NavLayout>(currentLayout);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const queries = [window.matchMedia(TABLET), window.matchMedia(DESKTOP)];
    const update = () => setLayout(currentLayout());

    for (const query of queries) {
      query.addEventListener("change", update);
    }

    return () => {
      for (const query of queries) {
        query.removeEventListener("change", update);
      }
    };
  }, []);

  return layout;
}

export interface NavigationProps {
  readonly areas: readonly StaffAreaView[];
  readonly selectedArea: StaffArea | null;
  readonly currentSection: StaffSection | undefined;
  readonly open: boolean;
  readonly layout: NavLayout;
  readonly panelCollapsed: boolean;
  readonly onSelectArea: (area: StaffArea) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onTogglePanel: () => void;
}

export function Navigation({
  areas,
  selectedArea,
  currentSection,
  open,
  layout,
  panelCollapsed,
  onSelectArea,
  onOpenChange,
  onTogglePanel,
}: NavigationProps) {
  const t = useT();
  const navigate = useNavigate();
  const shown = areas.find((view) => view.area.id === selectedArea) ?? areas[0];

  return (
    <nav
      id="staff-navigation"
      className="nav"
      data-nav
      data-open={open}
      data-layout={layout}
      data-panel-collapsed={panelCollapsed}
      aria-label={t("staff.nav.label")}
    >
      <div className="rail">
        <Link
          to="/"
          className="rail-brand"
          aria-label={t("staff.brand")}
          onClick={() => onOpenChange(false)}
        >
          <span aria-hidden="true">{t("staff.brand").slice(0, 1)}</span>
        </Link>
        <ul className="rail-list">
          {areas.map((view) => {
            const Icon = AREA_ICONS[view.area.id];
            const label = t(view.area.labelKey);
            const active = currentSection?.area === view.area.id;
            const selected = shown?.area.id === view.area.id;

            return (
              <li key={view.area.id}>
                <button
                  type="button"
                  className="rail-item"
                  data-area={view.area.id}
                  data-active={active}
                  data-selected={selected}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  title={label}
                  onClick={() => {
                    onSelectArea(view.area.id);

                    if (layout === "desktop") {
                      if (!active) {
                        navigate(view.home.path);
                      }
                    } else {
                      onOpenChange(true);
                    }
                  }}
                >
                  <Icon size={20} />
                </button>
              </li>
            );
          })}
        </ul>
        {layout === "desktop" ? (
          <button
            type="button"
            className="rail-item rail-toggle"
            data-panel-toggle
            aria-pressed={!panelCollapsed}
            aria-label={panelCollapsed ? t("staff.nav.expand") : t("staff.nav.collapse")}
            title={panelCollapsed ? t("staff.nav.expand") : t("staff.nav.collapse")}
            onClick={onTogglePanel}
          >
            <IconPanel size={20} />
          </button>
        ) : null}
      </div>

      {shown === undefined ? null : (
        <div className="nav-panel" data-nav-panel={shown.area.id}>
          <div className="nav-panel-head">
            <span className="nav-panel-title">{t(shown.area.labelKey)}</span>
            {layout === "desktop" ? (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={t("staff.nav.collapse")}
                title={t("staff.nav.collapse")}
                onClick={onTogglePanel}
              >
                <IconChevronLeft size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label={t("staff.nav.close")}
                onClick={() => onOpenChange(false)}
              >
                <IconClose size={18} />
              </button>
            )}
          </div>
          <div className="nav-panel-body">
            {shown.groups.map((view) => (
              <div key={view.group.id} className="nav-group" data-nav-group={view.group.id}>
                <p className="nav-group-title" id={`nav-group-${shown.area.id}-${view.group.id}`}>
                  {t(view.group.labelKey)}
                </p>
                <ul aria-labelledby={`nav-group-${shown.area.id}-${view.group.id}`}>
                  {view.sections.map((section) => (
                    <li key={section.id}>
                      <Link
                        to={section.path}
                        className="nav-link"
                        aria-current={currentSection?.id === section.id ? "page" : undefined}
                        data-section={section.id}
                        onClick={() => onOpenChange(false)}
                      >
                        {t(section.labelKey)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
