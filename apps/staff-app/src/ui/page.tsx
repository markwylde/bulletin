import { useT } from "@bulletin/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "./Button.tsx";
import { IconMore, IconSearch } from "./icons.tsx";
import { Notice, PageHeader, Panel, Skeleton } from "./layout.tsx";
import { useDismiss } from "./overlays.tsx";

type DataAttributes = Record<`data-${string}`, string | boolean | undefined>;

export interface PageProps extends DataAttributes {
  /** The page's `data-page` hook. */
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly meta?: ReactNode;
  /** `narrow` caps settings pages at a readable measure. */
  readonly width?: "full" | "narrow";
  readonly children?: ReactNode;
}

/** Every staff page: header, then its panels stacked with a consistent gap. */
export function Page({
  id,
  title,
  description,
  actions,
  meta,
  width = "full",
  children,
  ...data
}: PageProps) {
  return (
    <div
      className={width === "narrow" ? "page-content page-content-narrow" : "page-content"}
      data-page={id}
      {...data}
    >
      <PageHeader title={title} description={description} actions={actions} meta={meta} />
      {children}
    </div>
  );
}

/** Loading skeleton, an error notice with retry, or the loaded content. */
export function QueryState<T>({
  query,
  errorLabel,
  lines = 4,
  errorProps,
  children,
}: {
  readonly query: UseQueryResult<T>;
  readonly errorLabel: ReactNode;
  readonly lines?: number;
  readonly errorProps?: DataAttributes;
  readonly children: (data: T) => ReactNode;
}) {
  const t = useT();

  if (query.isPending) {
    return (
      <Panel>
        <Skeleton lines={lines} label={t("staff.widget.loading")} />
      </Panel>
    );
  }

  if (query.isError) {
    return (
      <Notice
        tone="danger"
        role="alert"
        title={errorLabel}
        action={
          <Button size="sm" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </Button>
        }
        {...errorProps}
      />
    );
  }

  return <>{children(query.data)}</>;
}

/**
 * Quiet row actions behind a "⋯" button. Items stay mounted while closed so their hooks
 * exist for tests and assistive tech; choosing one closes the menu.
 */
export function RowActions({
  label,
  children,
  ...data
}: { readonly label: string; readonly children: ReactNode } & DataAttributes) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef([rootRef]).current;
  const id = useId();
  useDismiss(refs, open, () => setOpen(false));

  return (
    <div ref={rootRef} className="menu row-actions" {...data}>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <IconMore size={16} />
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: items are buttons; this only closes the menu after one runs */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      <div
        id={id}
        className="menu-popover menu-popover-end"
        hidden={!open}
        data-menu-open={open}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button, a") !== null) {
            setOpen(false);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function MenuItem({
  tone = "default",
  icon,
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: "default" | "danger";
  readonly icon?: ReactNode;
} & DataAttributes) {
  return (
    <button
      type={type}
      className={["menu-item", tone === "danger" ? "menu-item-danger" : null, className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

/** The bar above a list: search and filters on the left, actions on the right. */
export function Toolbar({
  children,
  actions,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly actions?: ReactNode }) {
  return (
    <div className="toolbar" {...props}>
      <div className="toolbar-filters">{children}</div>
      {actions === undefined ? null : <div className="toolbar-actions">{actions}</div>}
    </div>
  );
}

export function SearchInput({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string } & DataAttributes) {
  return (
    <label className="search-input">
      <IconSearch size={16} />
      <span className="sr-only">{label}</span>
      <input type="search" placeholder={label} autoComplete="off" {...props} />
    </label>
  );
}

/** A titled group of settings rows. */
export function SettingsSection({
  title,
  description,
  children,
  actions,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}) {
  const titleId = useId();

  return (
    <Panel
      title={title}
      description={description}
      actions={actions}
      titleId={titleId}
      className="settings-section"
      {...props}
    >
      {children}
    </Panel>
  );
}

/**
 * Save and discard for a settings form. It sticks to the bottom of the viewport while the
 * form has unsaved changes.
 */
export function SaveBar({
  dirty,
  children,
  message,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  readonly dirty: boolean;
  readonly message?: ReactNode;
}) {
  return (
    <div className="save-bar" data-dirty={dirty} {...props}>
      <p className="save-bar-message">{dirty ? message : null}</p>
      <div className="save-bar-actions">{children}</div>
    </div>
  );
}

/** Previous / next paging for server-paged lists. */
export function Pager({
  label,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  status,
  previousProps,
  nextProps,
}: {
  readonly label: string;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onPrevious?: () => void;
  readonly onNext: () => void;
  readonly status?: ReactNode;
  readonly previousProps?: DataAttributes;
  readonly nextProps?: DataAttributes;
}) {
  const t = useT();

  if (!hasPrevious && !hasNext) {
    return null;
  }

  return (
    <nav className="pager" aria-label={label}>
      {onPrevious === undefined ? (
        <span />
      ) : (
        <Button size="sm" disabled={!hasPrevious} onClick={onPrevious} {...previousProps}>
          {t("staff.pager.previous")}
        </Button>
      )}
      {status === undefined ? null : <span className="pager-status">{status}</span>}
      <Button size="sm" disabled={!hasNext} onClick={onNext} {...nextProps}>
        {t("staff.pager.next")}
      </Button>
    </nav>
  );
}

/** A small colour swatch beside a label. */
export function Swatch({ color }: { readonly color: string }) {
  return <span className="swatch" style={{ background: color }} aria-hidden="true" />;
}

/** Label/value pairs, two columns on wide screens. */
export function DescriptionList({
  items,
  ...props
}: {
  readonly items: readonly {
    readonly id: string;
    readonly label: ReactNode;
    readonly value: ReactNode;
  }[];
} & HTMLAttributes<HTMLDListElement>) {
  return (
    <dl className="description-list" {...props}>
      {items.map((item) => (
        <div key={item.id} className="description-list-item">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
