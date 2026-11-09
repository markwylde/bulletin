import { useT } from "@bulletin/ui";
import { DevSensitiveCheck } from "../dev-sensitive.tsx";
import { useSession } from "../session.tsx";
import { visibleDashboardWidgets, WidgetCard } from "./widgets.tsx";

export function DashboardPage() {
  const t = useT();
  const { permissions } = useSession();
  const widgets = visibleDashboardWidgets(permissions);

  return (
    <div className="page" data-page="dashboard">
      <header className="page-header">
        <h1>{t("staff.dashboard.title")}</h1>
        <p>{t("staff.dashboard.intro")}</p>
      </header>

      <div className="widget-grid">
        {widgets.map((widget) => {
          const Widget = widget.component;

          return (
            <WidgetCard key={widget.id} id={widget.id} titleKey={widget.titleKey}>
              <Widget />
            </WidgetCard>
          );
        })}
      </div>

      {import.meta.env.DEV ? <DevSensitiveCheck /> : null}
    </div>
  );
}
