import { useT } from "@bulletin/ui";
import { Link } from "react-router";
import { DevSensitiveCheck } from "../dev-sensitive.tsx";
import { STAFF_SECTIONS, visibleSections } from "../sections.ts";
import { useSession } from "../session.tsx";
import { AREA_ICONS } from "../shell/navigation.tsx";
import { IconChevronRight } from "../ui/icons.tsx";
import { PageHeader, Panel } from "../ui/layout.tsx";
import {
  type DashboardWidget,
  visibleDashboardWidgets,
  WIDGET_ACTIONS,
  WidgetCard,
} from "./widgets.tsx";

/** Everyday destinations, shown when the viewer can open them. Flag-gated sections are left out. */
const SHORTCUT_IDS = [
  "forums",
  "memberProfiles",
  "groups",
  "permissions",
  "themes",
  "boardSettings",
];

function WidgetSlot({ widget }: { readonly widget: DashboardWidget }) {
  const Widget = widget.component;
  const Actions = WIDGET_ACTIONS[widget.id];

  return (
    <WidgetCard
      id={widget.id}
      titleKey={widget.titleKey}
      flush
      actions={Actions === undefined ? undefined : <Actions />}
    >
      <Widget />
    </WidgetCard>
  );
}

function Shortcuts() {
  const t = useT();
  const { permissions } = useSession();
  const reachable = new Set(visibleSections(permissions).map((section) => section.id));
  const shortcuts = SHORTCUT_IDS.flatMap((id) => {
    const section = STAFF_SECTIONS.find((candidate) => candidate.id === id);

    return section !== undefined && reachable.has(id) ? [section] : [];
  });

  if (shortcuts.length === 0) {
    return null;
  }

  return (
    <Panel title={t("staff.dashboard.shortcuts.title")} titleId="dashboard-shortcuts" flush>
      <ul className="shortcut-list" data-dashboard-shortcuts>
        {shortcuts.map((section) => {
          const Icon = AREA_ICONS[section.area];

          return (
            <li key={section.id}>
              <Link className="shortcut" to={section.path} data-shortcut={section.id}>
                <span className="shortcut-icon">
                  <Icon size={16} />
                </span>
                <span className="shortcut-label">{t(section.labelKey)}</span>
                <IconChevronRight size={16} className="shortcut-go" />
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function DashboardPage() {
  const t = useT();
  const { permissions } = useSession();
  const widgets = visibleDashboardWidgets(permissions);
  const kpis = widgets.filter((widget) => widget.slot === "kpi");
  const log = widgets.find((widget) => widget.id === "log");
  const health = widgets.find((widget) => widget.id === "health");

  return (
    <div className="dashboard" data-page="dashboard">
      <PageHeader title={t("staff.dashboard.title")} description={t("staff.dashboard.intro")} />

      {kpis.length === 0 ? null : (
        <div className="dashboard-kpis">
          {kpis.map((widget) => (
            <WidgetSlot key={widget.id} widget={widget} />
          ))}
        </div>
      )}

      <div className="dashboard-activity">
        {log === undefined ? null : (
          <div className="dashboard-main">
            <WidgetSlot widget={log} />
          </div>
        )}
        <div className="dashboard-aside">
          {health === undefined ? null : <WidgetSlot widget={health} />}
          <Shortcuts />
        </div>
      </div>

      {import.meta.env.DEV ? <DevSensitiveCheck /> : null}
    </div>
  );
}
