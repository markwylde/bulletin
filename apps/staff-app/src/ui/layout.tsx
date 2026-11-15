import type { HTMLAttributes, ReactNode } from "react";
import { Link } from "react-router";
import { IconChevronLeft, IconChevronRight } from "./icons.tsx";

export interface Crumb {
  readonly label: string;
  /** Omitted for the current page. */
  readonly to?: string;
}

/** Desktop: the full trail. Phones: "‹ parent" only (ADR 0021). */
export function Breadcrumbs({
  items,
  label,
}: {
  readonly items: readonly Crumb[];
  readonly label: string;
}) {
  if (items.length === 0) {
    return null;
  }

  const parent = [...items].reverse().find((item) => item.to !== undefined);

  return (
    <nav className="breadcrumbs" aria-label={label} data-breadcrumbs>
      <ol className="breadcrumbs-list">
        {items.map((item, index) => (
          <li key={item.to ?? item.label} className="breadcrumbs-item">
            {index > 0 ? <IconChevronRight size={14} className="breadcrumbs-sep" /> : null}
            {item.to === undefined ? (
              <span aria-current="page">{item.label}</span>
            ) : (
              <Link to={item.to}>{item.label}</Link>
            )}
          </li>
        ))}
      </ol>
      {parent?.to === undefined ? null : (
        <Link className="breadcrumbs-back" to={parent.to}>
          <IconChevronLeft size={16} />
          <span>{parent.label}</span>
        </Link>
      )}
    </nav>
  );
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Primary actions, right-aligned on wide screens. */
  readonly actions?: ReactNode;
  readonly meta?: ReactNode;
}

export function PageHeader({ title, description, actions, meta }: PageHeaderProps) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description === undefined ? null : <p className="page-head-description">{description}</p>}
        {meta === undefined ? null : <div className="page-head-meta">{meta}</div>}
      </div>
      {actions === undefined ? null : <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  /** Removes body padding so tables and lists run edge to edge. */
  readonly flush?: boolean;
  readonly titleId?: string;
}

export function Panel({
  title,
  description,
  actions,
  footer,
  flush = false,
  titleId,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <section
      className={["panel", className].filter(Boolean).join(" ")}
      aria-labelledby={title === undefined ? undefined : titleId}
      {...props}
    >
      {title === undefined && actions === undefined ? null : (
        <header className="panel-head">
          <div className="panel-head-text">
            {title === undefined ? null : <h2 id={titleId}>{title}</h2>}
            {description === undefined ? null : (
              <p className="panel-head-description">{description}</p>
            )}
          </div>
          {actions === undefined ? null : <div className="panel-head-actions">{actions}</div>}
        </header>
      )}
      <div className={flush ? "panel-body panel-body-flush" : "panel-body"}>{children}</div>
      {footer === undefined ? null : <footer className="panel-foot">{footer}</footer>}
    </section>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export function Badge({
  tone = "neutral",
  dot = false,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { readonly tone?: Tone; readonly dot?: boolean }) {
  return (
    <span className={`badge badge-${tone}`} {...props}>
      {dot ? <span className="badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon === undefined ? null : <div className="empty-state-icon">{icon}</div>}
      <p className="empty-state-title">{title}</p>
      {description === undefined ? null : <p className="empty-state-description">{description}</p>}
      {action === undefined ? null : <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/** A loading placeholder. `lines` stacks text-height bars. */
export function Skeleton({
  lines = 1,
  width,
  height,
  label,
}: {
  readonly lines?: number;
  readonly width?: string;
  readonly height?: string;
  /** Announced to screen readers while loading. */
  readonly label?: string;
}) {
  return (
    <div className="skeleton-stack" role={label === undefined ? undefined : "status"}>
      {label === undefined ? null : <span className="sr-only">{label}</span>}
      {Array.from({ length: lines }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no identity
          key={index}
          className="skeleton"
          aria-hidden="true"
          style={{
            width: width ?? (lines > 1 && index === lines - 1 ? "60%" : "100%"),
            height,
          }}
        />
      ))}
    </div>
  );
}

export interface Stat {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
  readonly valueProps?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | boolean>;
}

/** A row of labelled numbers. Values use tabular figures. */
export function StatGroup({
  stats,
  ...props
}: { readonly stats: readonly Stat[] } & HTMLAttributes<HTMLDListElement>) {
  return (
    <dl className="stat-group" {...props}>
      {stats.map((stat) => (
        <div key={stat.id} className="stat">
          <dt className="stat-label">{stat.label}</dt>
          <dd className="stat-value" {...stat.valueProps}>
            {stat.value}
          </dd>
          {stat.hint === undefined ? null : <dd className="stat-hint">{stat.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function StatCard({
  label,
  value,
  hint,
  ...props
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly hint?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="stat-card" {...props}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {hint === undefined ? null : <p className="stat-hint">{hint}</p>}
    </div>
  );
}

/** Inline status message. */
export function Notice({
  tone = "neutral",
  title,
  children,
  action,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  readonly tone?: Tone;
  readonly title?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} {...props}>
      <div className="notice-text">
        {title === undefined ? null : <p className="notice-title">{title}</p>}
        {children === undefined ? null : <div className="notice-body">{children}</div>}
      </div>
      {action === undefined ? null : <div className="notice-action">{action}</div>}
    </div>
  );
}
