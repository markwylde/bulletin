import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormActions,
  IconButton,
  IconEdit,
  IconPlus,
  IconTrash,
  MenuItem,
  Page,
  Panel,
  RowActions,
  Select,
  Switch,
  Table,
  TextInput,
} from "../ui/index.ts";

interface ReasonRecord {
  readonly id: string;
  readonly key: string;
  readonly points: number;
  readonly expiryDays: number;
  readonly allowPointsOverride: boolean;
  readonly enabled: boolean;
  readonly position: number;
  readonly labels: Readonly<Record<string, string | undefined>>;
}

interface ThresholdRecord {
  readonly id: string;
  readonly points: number;
  readonly action: "mod_queue" | "suspend" | "ban";
  readonly durationHours: number | null;
}

interface WarningSettings {
  readonly reasons: readonly ReasonRecord[];
  readonly thresholds: readonly ThresholdRecord[];
}

interface ReasonDraft {
  readonly id: string | null;
  readonly key: string;
  readonly points: number;
  readonly expiryDays: number;
  readonly allowPointsOverride: boolean;
  readonly enabled: boolean;
  readonly position: number;
  readonly en: string;
  readonly es: string;
  readonly fr: string;
}

function actionLabel(t: ReturnType<typeof useT>, action: ThresholdRecord["action"]): string {
  switch (action) {
    case "mod_queue":
      return t("staff.warnings.action.modQueue");
    case "suspend":
      return t("staff.warnings.action.suspend");
    case "ban":
      return t("staff.warnings.action.ban");
  }
}

const EMPTY_REASON: ReasonDraft = {
  id: null,
  key: "",
  points: 1,
  expiryDays: 30,
  allowPointsOverride: false,
  enabled: true,
  position: 0,
  en: "",
  es: "",
  fr: "",
};

export function WarningsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<ReasonDraft>(EMPTY_REASON);
  const [confirm, setConfirm] = useState<{ kind: "reason" | "threshold"; id: string } | null>(null);
  const [thresholdPoints, setThresholdPoints] = useState(10);
  const [thresholdAction, setThresholdAction] = useState<ThresholdRecord["action"]>("suspend");
  const [thresholdHours, setThresholdHours] = useState(168);
  const query = useQuery({
    queryKey: ["staff", "warnings"],
    queryFn: () => apiGet<WarningSettings>("/api/staff/warnings"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/warnings", body),
    onSuccess: async () => {
      toast.pushToast({ messageKey: "staff.warnings.saved", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: ["staff", "warnings"] });
    },
  });

  const editReason = (record: ReasonRecord): void => {
    setReason({
      id: record.id,
      key: record.key,
      points: record.points,
      expiryDays: record.expiryDays,
      allowPointsOverride: record.allowPointsOverride,
      enabled: record.enabled,
      position: record.position,
      en: record.labels.en ?? "",
      es: record.labels.es ?? "",
      fr: record.labels.fr ?? "",
    });
  };

  const saveReason = (): void => {
    mutate.mutate({
      kind: "reason",
      action: "save",
      ...(reason.id === null ? {} : { id: reason.id }),
      key: reason.key,
      points: reason.points,
      expiryDays: reason.expiryDays,
      allowPointsOverride: reason.allowPointsOverride,
      enabled: reason.enabled,
      position: reason.position,
      labels: { en: reason.en, es: reason.es, fr: reason.fr },
    });
    setReason(EMPTY_REASON);
  };

  const saveThreshold = (): void => {
    mutate.mutate({
      kind: "threshold",
      action: "save",
      points: thresholdPoints,
      thresholdAction,
      durationHours: thresholdAction === "ban" ? null : thresholdHours,
    });
  };

  const reasonText = (
    field: "key" | "en" | "es" | "fr",
    label: string,
    hook: string,
    maxLength: number,
  ) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [hook]: true }}
          maxLength={maxLength}
          value={reason[field]}
          onChange={(event) =>
            setReason((current) => ({ ...current, [field]: event.target.value }))
          }
        />
      )}
    </Field>
  );
  const reasonNumber = (
    field: "points" | "expiryDays",
    label: string,
    hook: string,
    max: number,
  ) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [hook]: true }}
          type="number"
          min={0}
          max={max}
          value={reason[field]}
          onChange={(event) =>
            setReason((current) => ({ ...current, [field]: Number(event.target.value) }))
          }
        />
      )}
    </Field>
  );

  return (
    <Page id="warnings" title={t("staff.warnings.title")} description={t("staff.warnings.intro")}>
      <div className="page-split">
        <Panel flush title={t("staff.warnings.reasons.title")}>
          <div data-warning-reason-list>
            <Table
              caption={t("staff.warnings.reasons.title")}
              rows={query.data?.reasons ?? []}
              rowKey={(record) => record.id}
              rowProps={(record) => ({ "data-warning-reason": record.id })}
              empty={<EmptyState title={t("staff.warnings.reasons.empty")} />}
              columns={[
                {
                  id: "label",
                  header: t("staff.warnings.reason.en"),
                  primary: true,
                  cell: (record) => (
                    <span className="cluster">
                      <span className="list-row-title">{record.labels.en ?? record.key}</span>
                      {record.enabled ? null : <Badge>{t("staff.warnings.reason.disabled")}</Badge>}
                    </span>
                  ),
                },
                {
                  id: "points",
                  header: t("staff.warnings.reason.points"),
                  align: "end",
                  cell: (record) => record.points,
                },
                {
                  id: "expiry",
                  header: t("staff.warnings.reason.expiry"),
                  align: "end",
                  cell: (record) => record.expiryDays,
                },
                {
                  id: "actions",
                  header: t("staff.rowActions"),
                  align: "end",
                  width: "5.5rem",
                  cell: (record) => (
                    <span className="cluster cluster-end">
                      <IconButton
                        size="sm"
                        label={t("staff.warnings.edit")}
                        data-warning-reason-edit={record.id}
                        onClick={() => editReason(record)}
                      >
                        <IconEdit size={16} />
                      </IconButton>
                      <RowActions label={t("staff.rowActions")}>
                        <MenuItem
                          tone="danger"
                          icon={<IconTrash size={16} />}
                          data-warning-reason-delete={record.id}
                          disabled={mutate.isPending}
                          onClick={() => setConfirm({ kind: "reason", id: record.id })}
                        >
                          {t("staff.warnings.delete")}
                        </MenuItem>
                      </RowActions>
                    </span>
                  ),
                },
              ]}
            />
          </div>
        </Panel>

        <Panel
          title={
            reason.id === null
              ? t("staff.warnings.reason.new")
              : t("staff.warnings.reason.editTitle")
          }
        >
          <div className="stack" data-warning-reason-form>
            {reasonText("key", t("staff.warnings.reason.key"), "data-warning-reason-key", 64)}
            {reasonText("en", t("staff.warnings.reason.en"), "data-warning-reason-en", 120)}
            {reasonText("es", t("staff.warnings.reason.es"), "data-warning-reason-es", 120)}
            {reasonText("fr", t("staff.warnings.reason.fr"), "data-warning-reason-fr", 120)}
            <div className="form-grid">
              {reasonNumber(
                "points",
                t("staff.warnings.reason.points"),
                "data-warning-reason-points",
                1000,
              )}
              {reasonNumber(
                "expiryDays",
                t("staff.warnings.reason.expiry"),
                "data-warning-reason-expiry",
                3650,
              )}
            </div>
            <div className="stack stack-sm">
              <Switch
                data-warning-reason-override
                label={t("staff.warnings.reason.allowOverride")}
                checked={reason.allowPointsOverride}
                onChange={(event) =>
                  setReason((current) => ({
                    ...current,
                    allowPointsOverride: event.target.checked,
                  }))
                }
              />
              <Switch
                data-warning-reason-enabled
                label={t("staff.warnings.reason.enabled")}
                checked={reason.enabled}
                onChange={(event) =>
                  setReason((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
            </div>
            <FormActions>
              <Button variant="ghost" onClick={() => setReason(EMPTY_REASON)}>
                {t("staff.warnings.cancel")}
              </Button>
              <Button
                variant="primary"
                data-warning-reason-save
                disabled={mutate.isPending}
                onClick={saveReason}
              >
                {t("staff.warnings.save")}
              </Button>
            </FormActions>
          </div>
        </Panel>
      </div>

      <Panel flush title={t("staff.warnings.thresholds.title")}>
        <form
          className="toolbar"
          data-warning-threshold-form
          onSubmit={(event) => {
            event.preventDefault();
            saveThreshold();
          }}
        >
          <div className="toolbar-filters">
            <Field label={t("staff.warnings.threshold.points")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  data-warning-threshold-points
                  type="number"
                  min={1}
                  max={1000}
                  value={thresholdPoints}
                  onChange={(event) => setThresholdPoints(Number(event.target.value))}
                />
              )}
            </Field>
            <Field label={t("staff.warnings.threshold.action")}>
              {({ id }) => (
                <Select
                  id={id}
                  data-warning-threshold-action
                  value={thresholdAction}
                  onChange={(event) =>
                    setThresholdAction(event.target.value as ThresholdRecord["action"])
                  }
                >
                  <option value="mod_queue">{t("staff.warnings.action.modQueue")}</option>
                  <option value="suspend">{t("staff.warnings.action.suspend")}</option>
                  <option value="ban">{t("staff.warnings.action.ban")}</option>
                </Select>
              )}
            </Field>
            {thresholdAction === "ban" ? null : (
              <Field label={t("staff.warnings.threshold.duration")}>
                {({ id }) => (
                  <TextInput
                    id={id}
                    data-warning-threshold-duration
                    type="number"
                    min={1}
                    max={87600}
                    value={thresholdHours}
                    onChange={(event) => setThresholdHours(Number(event.target.value))}
                  />
                )}
              </Field>
            )}
            <Button
              type="submit"
              variant="primary"
              icon={<IconPlus size={16} />}
              data-warning-threshold-save
              disabled={mutate.isPending}
            >
              {t("staff.warnings.threshold.add")}
            </Button>
          </div>
        </form>
        {(query.data?.thresholds ?? []).length === 0 ? (
          <EmptyState title={t("staff.warnings.thresholds.empty")} />
        ) : null}
        <ul className="list" data-warning-threshold-list>
          {(query.data?.thresholds ?? []).map((threshold) => (
            <li key={threshold.id} className="list-row" data-warning-threshold={threshold.id}>
              <div className="list-row-main">
                <span className="list-row-title">
                  {t("staff.warnings.threshold.summary", {
                    points: threshold.points,
                    action: actionLabel(t, threshold.action),
                  })}
                </span>
                {threshold.durationHours === null ? null : (
                  <span className="list-row-meta">
                    {t("staff.warnings.threshold.hours", { hours: threshold.durationHours })}
                  </span>
                )}
              </div>
              <div className="list-row-actions">
                <IconButton
                  size="sm"
                  label={t("staff.warnings.delete")}
                  data-warning-threshold-delete={threshold.id}
                  disabled={mutate.isPending}
                  onClick={() => setConfirm({ kind: "threshold", id: threshold.id })}
                >
                  <IconTrash size={16} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <ConfirmDialog
        open={confirm !== null}
        titleKey={
          confirm?.kind === "threshold"
            ? "staff.warnings.confirmThreshold.title"
            : "staff.warnings.confirmReason.title"
        }
        bodyKey={
          confirm?.kind === "threshold"
            ? "staff.warnings.confirmThreshold.body"
            : "staff.warnings.confirmReason.body"
        }
        confirmLabelKey="staff.warnings.delete"
        tone="danger"
        busy={mutate.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);

          if (target !== null) {
            mutate.mutate({ kind: target.kind, action: "delete", id: target.id });
          }
        }}
      />
    </Page>
  );
}
