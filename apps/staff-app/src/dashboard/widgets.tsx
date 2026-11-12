import type { AcpPermission } from "@bulletin/domain/permissions";
import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { apiGet } from "../api.ts";

export interface DashboardWidget {
  readonly id: string;
  readonly permission: AcpPermission;
  readonly titleKey: string;
  readonly component: ComponentType;
}

interface MemberStats {
  readonly total: number;
  readonly active: number;
  readonly joinedLast7Days: number;
}

interface TopicStats {
  readonly topics: number;
  readonly posts: number;
  readonly postsToday: number;
}

interface AdminLogEntry {
  readonly id: string;
  readonly actor: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly createdAt: string;
}

interface HealthReport {
  readonly status: "ok" | "degraded";
  readonly checks: Readonly<Record<string, boolean>>;
}

export function WidgetCard({
  id,
  titleKey,
  children,
}: {
  readonly id: string;
  readonly titleKey: string;
  readonly children: ReactNode;
}) {
  const t = useT();

  return (
    <section className="widget" data-widget={id} aria-labelledby={`widget-${id}-title`}>
      <h2 id={`widget-${id}-title`}>{t(titleKey)}</h2>
      {children}
    </section>
  );
}

function WidgetState({ error, retry }: { readonly error: boolean; readonly retry: () => void }) {
  const t = useT();

  if (!error) {
    return <p className="widget-muted">{t("staff.widget.loading")}</p>;
  }

  return (
    <div className="widget-error" role="alert">
      <p>{t("staff.widget.error")}</p>
      <button type="button" onClick={retry}>
        {t("staff.widget.retry")}
      </button>
    </div>
  );
}

function MemberStatsWidget() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({
    queryKey: ["staff", "dashboard", "members"],
    queryFn: () => apiGet<MemberStats>("/api/staff/dashboard/members"),
  });

  if (query.isPending || query.isError) {
    return <WidgetState error={query.isError} retry={() => void query.refetch()} />;
  }

  return (
    <dl className="stat-grid" data-widget-body="members">
      <div>
        <dt>{t("staff.dashboard.members.total")}</dt>
        <dd>{formatNumber(query.data.total, locale)}</dd>
      </div>
      <div>
        <dt>{t("staff.dashboard.members.active")}</dt>
        <dd>{formatNumber(query.data.active, locale)}</dd>
      </div>
      <div>
        <dt>{t("staff.dashboard.members.new")}</dt>
        <dd>{formatNumber(query.data.joinedLast7Days, locale)}</dd>
      </div>
    </dl>
  );
}

function TopicStatsWidget() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({
    queryKey: ["staff", "dashboard", "topics"],
    queryFn: () => apiGet<TopicStats>("/api/staff/dashboard/topics"),
  });

  if (query.isPending || query.isError) {
    return <WidgetState error={query.isError} retry={() => void query.refetch()} />;
  }

  return (
    <dl className="stat-grid" data-widget-body="topics">
      <div>
        <dt>{t("staff.dashboard.topics.topics")}</dt>
        <dd>{formatNumber(query.data.topics, locale)}</dd>
      </div>
      <div>
        <dt>{t("staff.dashboard.topics.posts")}</dt>
        <dd>{formatNumber(query.data.posts, locale)}</dd>
      </div>
      <div>
        <dt>{t("staff.dashboard.topics.today")}</dt>
        <dd>{formatNumber(query.data.postsToday, locale)}</dd>
      </div>
    </dl>
  );
}

function PendingModerationWidget() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({
    queryKey: ["staff", "dashboard", "moderation"],
    queryFn: () => apiGet<{ count: number }>("/api/staff/dashboard/moderation"),
  });

  if (query.isPending || query.isError) {
    return <WidgetState error={query.isError} retry={() => void query.refetch()} />;
  }

  return (
    <dl className="stat-grid" data-widget-body="moderation">
      <div>
        <dt>{t("staff.dashboard.moderation.pending")}</dt>
        <dd data-moderation-pending-count>{formatNumber(query.data.count, locale)}</dd>
      </div>
    </dl>
  );
}

function AdminLogWidget() {
  const t = useT();
  const locale = useLocale();
  const query = useQuery({
    queryKey: ["staff", "dashboard", "log"],
    queryFn: () => apiGet<{ entries: AdminLogEntry[] }>("/api/staff/dashboard/log"),
  });

  if (query.isPending || query.isError) {
    return <WidgetState error={query.isError} retry={() => void query.refetch()} />;
  }

  if (query.data.entries.length === 0) {
    return <p className="widget-muted">{t("staff.dashboard.log.empty")}</p>;
  }

  return (
    <ul className="log-list" data-widget-body="log">
      {query.data.entries.map((entry) => (
        <li key={entry.id} data-log-entry>
          <span className="log-action">{entry.action}</span>
          <span className="log-actor">{entry.actor ?? t("staff.dashboard.log.system")}</span>
          <time dateTime={entry.createdAt}>
            {formatDate(new Date(entry.createdAt), locale, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </li>
      ))}
    </ul>
  );
}

function HealthWidget() {
  const t = useT();
  const query = useQuery({
    queryKey: ["staff", "dashboard", "health"],
    queryFn: () => apiGet<HealthReport>("/api/staff/dashboard/health"),
  });

  if (query.isPending || query.isError) {
    return <WidgetState error={query.isError} retry={() => void query.refetch()} />;
  }

  const checkLabel = (name: string): string => {
    switch (name) {
      case "database":
        return t("staff.dashboard.health.database");
      case "migrations":
        return t("staff.dashboard.health.migrations");
      case "listener":
        return t("staff.dashboard.health.listener");
      default:
        return name;
    }
  };

  return (
    <div data-widget-body="health">
      <p
        className={`health-status health-status-${query.data.status}`}
        data-health-status={query.data.status}
      >
        {query.data.status === "ok"
          ? t("staff.dashboard.health.ok")
          : t("staff.dashboard.health.degraded")}
      </p>
      <ul className="health-list">
        {Object.entries(query.data.checks).map(([name, ok]) => (
          <li key={name} data-health-check={name} data-health-ok={ok}>
            <span>{checkLabel(name)}</span>
            <span>{ok ? t("staff.dashboard.health.up") : t("staff.dashboard.health.down")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Permission-gated dashboard widgets. The API checks the same permissions again. */
export const DASHBOARD_WIDGETS: readonly DashboardWidget[] = [
  {
    id: "members",
    permission: "acp.members",
    titleKey: "staff.dashboard.members.title",
    component: MemberStatsWidget,
  },
  {
    id: "topics",
    permission: "acp.members",
    titleKey: "staff.dashboard.topics.title",
    component: TopicStatsWidget,
  },
  {
    id: "moderation",
    permission: "acp.members",
    titleKey: "staff.dashboard.moderation.title",
    component: PendingModerationWidget,
  },
  {
    id: "log",
    permission: "acp.log",
    titleKey: "staff.dashboard.log.title",
    component: AdminLogWidget,
  },
  {
    id: "health",
    permission: "acp.system",
    titleKey: "staff.dashboard.health.title",
    component: HealthWidget,
  },
];

export function visibleDashboardWidgets(
  permissions: readonly string[],
  widgets: readonly DashboardWidget[] = DASHBOARD_WIDGETS,
): DashboardWidget[] {
  return widgets.filter((widget) => permissions.includes(widget.permission));
}
