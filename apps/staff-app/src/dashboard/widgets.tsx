import type { AcpPermission } from "@bulletin/domain/permissions";
import { formatDate, formatNumber } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { Link } from "react-router";
import { apiGet } from "../api.ts";
import { STAFF_SECTIONS } from "../sections.ts";
import { useSession } from "../session.tsx";
import { Button } from "../ui/Button.tsx";
import { IconArrowRight } from "../ui/icons.tsx";
import { Badge, Notice, Panel, Skeleton, StatGroup } from "../ui/layout.tsx";

export interface DashboardWidget {
  readonly id: string;
  readonly permission: AcpPermission;
  readonly titleKey: string;
  readonly component: ComponentType;
  /** Where the widget sits: the KPI row or the activity row. */
  readonly slot: "kpi" | "activity";
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
  actions,
  flush = false,
  children,
}: {
  readonly id: string;
  readonly titleKey: string;
  readonly actions?: ReactNode;
  readonly flush?: boolean;
  readonly children: ReactNode;
}) {
  const t = useT();

  return (
    <Panel
      className="widget-panel"
      data-widget={id}
      title={t(titleKey)}
      titleId={`widget-${id}-title`}
      actions={actions}
      flush={flush}
    >
      {children}
    </Panel>
  );
}

function WidgetState({
  error,
  retry,
  lines = 2,
}: {
  readonly error: boolean;
  readonly retry: () => void;
  readonly lines?: number;
}) {
  const t = useT();

  if (!error) {
    return (
      <div className="widget-pad">
        <Skeleton lines={lines} label={t("staff.widget.loading")} />
      </div>
    );
  }

  return (
    <div className="widget-pad">
      <Notice
        tone="danger"
        role="alert"
        title={t("staff.widget.error")}
        action={
          <Button size="sm" onClick={retry}>
            {t("staff.widget.retry")}
          </Button>
        }
      />
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
    <StatGroup
      data-widget-body="members"
      stats={[
        {
          id: "total",
          label: t("staff.dashboard.members.total"),
          value: formatNumber(query.data.total, locale),
        },
        {
          id: "active",
          label: t("staff.dashboard.members.active"),
          value: formatNumber(query.data.active, locale),
        },
        {
          id: "new",
          label: t("staff.dashboard.members.new"),
          value: formatNumber(query.data.joinedLast7Days, locale),
        },
      ]}
    />
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
    <StatGroup
      data-widget-body="topics"
      stats={[
        {
          id: "topics",
          label: t("staff.dashboard.topics.topics"),
          value: formatNumber(query.data.topics, locale),
        },
        {
          id: "posts",
          label: t("staff.dashboard.topics.posts"),
          value: formatNumber(query.data.posts, locale),
        },
        {
          id: "today",
          label: t("staff.dashboard.topics.today"),
          value: formatNumber(query.data.postsToday, locale),
        },
      ]}
    />
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
    <StatGroup
      data-widget-body="moderation"
      stats={[
        {
          id: "pending",
          label: t("staff.dashboard.moderation.pending"),
          value: formatNumber(query.data.count, locale),
          valueProps: { "data-moderation-pending-count": true },
        },
      ]}
    />
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
    return <WidgetState error={query.isError} retry={() => void query.refetch()} lines={5} />;
  }

  if (query.data.entries.length === 0) {
    return <p className="widget-pad widget-empty">{t("staff.dashboard.log.empty")}</p>;
  }

  return (
    <ul className="activity-list" data-widget-body="log">
      {query.data.entries.map((entry) => (
        <li key={entry.id} className="activity-item" data-log-entry>
          <span className="activity-avatar" aria-hidden="true">
            {(entry.actor ?? t("staff.dashboard.log.system")).slice(0, 1).toUpperCase()}
          </span>
          <span className="activity-text">
            <span className="activity-action">{entry.action}</span>
            <span className="activity-actor">{entry.actor ?? t("staff.dashboard.log.system")}</span>
          </span>
          <time className="activity-time" dateTime={entry.createdAt}>
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
    return <WidgetState error={query.isError} retry={() => void query.refetch()} lines={4} />;
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
  const ok = query.data.status === "ok";

  return (
    <div data-widget-body="health">
      <div className="health-summary">
        <Badge tone={ok ? "success" : "danger"} dot data-health-status={query.data.status}>
          {ok ? t("staff.dashboard.health.ok") : t("staff.dashboard.health.degraded")}
        </Badge>
      </div>
      <ul className="check-rows">
        {Object.entries(query.data.checks).map(([name, up]) => (
          <li key={name} className="check-row" data-health-check={name} data-health-ok={up}>
            <span>{checkLabel(name)}</span>
            <Badge tone={up ? "success" : "danger"} dot>
              {up ? t("staff.dashboard.health.up") : t("staff.dashboard.health.down")}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The moderation widget links to the queue when the viewer can open it. */
function ModerationActions() {
  const t = useT();
  const { permissions } = useSession();
  const section = STAFF_SECTIONS.find((candidate) => candidate.id === "moderation");

  if (section === undefined || !permissions.includes(section.permission)) {
    return null;
  }

  return (
    <Link className="panel-link" to={section.path}>
      {t("staff.dashboard.moderation.review")}
      <IconArrowRight size={14} />
    </Link>
  );
}

function AdminLogActions() {
  const t = useT();
  const { permissions } = useSession();
  const section = STAFF_SECTIONS.find((candidate) => candidate.id === "adminLog");

  if (section === undefined || !permissions.includes(section.permission)) {
    return null;
  }

  return (
    <Link className="panel-link" to={section.path}>
      {t("staff.dashboard.log.viewAll")}
      <IconArrowRight size={14} />
    </Link>
  );
}

function HealthActions() {
  const t = useT();
  const { permissions } = useSession();
  const section = STAFF_SECTIONS.find((candidate) => candidate.id === "systemHealth");

  if (section === undefined || !permissions.includes(section.permission)) {
    return null;
  }

  return (
    <Link className="panel-link" to={section.path}>
      {t("staff.dashboard.health.details")}
      <IconArrowRight size={14} />
    </Link>
  );
}

export const WIDGET_ACTIONS: Readonly<Record<string, ComponentType>> = {
  moderation: ModerationActions,
  log: AdminLogActions,
  health: HealthActions,
};

/** Permission-gated dashboard widgets. The API checks the same permissions again. */
export const DASHBOARD_WIDGETS: readonly DashboardWidget[] = [
  {
    id: "members",
    permission: "acp.members",
    titleKey: "staff.dashboard.members.title",
    component: MemberStatsWidget,
    slot: "kpi",
  },
  {
    id: "topics",
    permission: "acp.members",
    titleKey: "staff.dashboard.topics.title",
    component: TopicStatsWidget,
    slot: "kpi",
  },
  {
    id: "moderation",
    permission: "acp.members",
    titleKey: "staff.dashboard.moderation.title",
    component: PendingModerationWidget,
    slot: "kpi",
  },
  {
    id: "log",
    permission: "acp.log",
    titleKey: "staff.dashboard.log.title",
    component: AdminLogWidget,
    slot: "activity",
  },
  {
    id: "health",
    permission: "acp.system",
    titleKey: "staff.dashboard.health.title",
    component: HealthWidget,
    slot: "activity",
  },
];

export function visibleDashboardWidgets(
  permissions: readonly string[],
  widgets: readonly DashboardWidget[] = DASHBOARD_WIDGETS,
): DashboardWidget[] {
  return widgets.filter((widget) => permissions.includes(widget.permission));
}
