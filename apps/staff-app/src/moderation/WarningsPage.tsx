import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

  return (
    <div className="page" data-page="warnings">
      <header className="page-header">
        <h1>{t("staff.warnings.title")}</h1>
        <p>{t("staff.warnings.intro")}</p>
      </header>

      <section className="admin-panel">
        <h2>{t("staff.warnings.reasons.title")}</h2>
        <div className="admin-form" data-warning-reason-form>
          <label>
            <span>{t("staff.warnings.reason.key")}</span>
            <input
              data-warning-reason-key
              value={reason.key}
              maxLength={64}
              onChange={(event) =>
                setReason((current) => ({ ...current, key: event.target.value }))
              }
            />
          </label>
          <label>
            <span>{t("staff.warnings.reason.en")}</span>
            <input
              data-warning-reason-en
              value={reason.en}
              maxLength={120}
              onChange={(event) => setReason((current) => ({ ...current, en: event.target.value }))}
            />
          </label>
          <label>
            <span>{t("staff.warnings.reason.es")}</span>
            <input
              data-warning-reason-es
              value={reason.es}
              maxLength={120}
              onChange={(event) => setReason((current) => ({ ...current, es: event.target.value }))}
            />
          </label>
          <label>
            <span>{t("staff.warnings.reason.fr")}</span>
            <input
              data-warning-reason-fr
              value={reason.fr}
              maxLength={120}
              onChange={(event) => setReason((current) => ({ ...current, fr: event.target.value }))}
            />
          </label>
          <label>
            <span>{t("staff.warnings.reason.points")}</span>
            <input
              data-warning-reason-points
              type="number"
              min={0}
              max={1000}
              value={reason.points}
              onChange={(event) =>
                setReason((current) => ({ ...current, points: Number(event.target.value) }))
              }
            />
          </label>
          <label>
            <span>{t("staff.warnings.reason.expiry")}</span>
            <input
              data-warning-reason-expiry
              type="number"
              min={0}
              max={3650}
              value={reason.expiryDays}
              onChange={(event) =>
                setReason((current) => ({ ...current, expiryDays: Number(event.target.value) }))
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              data-warning-reason-override
              checked={reason.allowPointsOverride}
              onChange={(event) =>
                setReason((current) => ({
                  ...current,
                  allowPointsOverride: event.target.checked,
                }))
              }
            />
            <span>{t("staff.warnings.reason.allowOverride")}</span>
          </label>
          <label>
            <input
              type="checkbox"
              data-warning-reason-enabled
              checked={reason.enabled}
              onChange={(event) =>
                setReason((current) => ({ ...current, enabled: event.target.checked }))
              }
            />
            <span>{t("staff.warnings.reason.enabled")}</span>
          </label>
          <div className="admin-form__actions">
            <button
              type="button"
              data-warning-reason-save
              disabled={mutate.isPending}
              onClick={saveReason}
            >
              {t("staff.warnings.save")}
            </button>
            <button type="button" className="button-quiet" onClick={() => setReason(EMPTY_REASON)}>
              {t("staff.warnings.cancel")}
            </button>
          </div>
        </div>

        <ul className="admin-list" data-warning-reason-list>
          {(query.data?.reasons ?? []).map((record) => (
            <li key={record.id} data-warning-reason={record.id}>
              <strong>{record.labels.en ?? record.key}</strong>
              <span className="widget-muted">
                {t("staff.warnings.reason.summary", {
                  points: record.points,
                  days: record.expiryDays,
                })}
              </span>
              <button type="button" className="button-quiet" onClick={() => editReason(record)}>
                {t("staff.warnings.edit")}
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={mutate.isPending}
                onClick={() => mutate.mutate({ kind: "reason", action: "delete", id: record.id })}
              >
                {t("staff.warnings.delete")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel">
        <h2>{t("staff.warnings.thresholds.title")}</h2>
        <div className="admin-form" data-warning-threshold-form>
          <label>
            <span>{t("staff.warnings.threshold.points")}</span>
            <input
              data-warning-threshold-points
              type="number"
              min={1}
              max={1000}
              value={thresholdPoints}
              onChange={(event) => setThresholdPoints(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{t("staff.warnings.threshold.action")}</span>
            <select
              data-warning-threshold-action
              value={thresholdAction}
              onChange={(event) =>
                setThresholdAction(event.target.value as ThresholdRecord["action"])
              }
            >
              <option value="mod_queue">{t("staff.warnings.action.modQueue")}</option>
              <option value="suspend">{t("staff.warnings.action.suspend")}</option>
              <option value="ban">{t("staff.warnings.action.ban")}</option>
            </select>
          </label>
          {thresholdAction === "ban" ? null : (
            <label>
              <span>{t("staff.warnings.threshold.duration")}</span>
              <input
                data-warning-threshold-duration
                type="number"
                min={1}
                max={87600}
                value={thresholdHours}
                onChange={(event) => setThresholdHours(Number(event.target.value))}
              />
            </label>
          )}
          <div className="admin-form__actions">
            <button
              type="button"
              data-warning-threshold-save
              disabled={mutate.isPending}
              onClick={saveThreshold}
            >
              {t("staff.warnings.save")}
            </button>
          </div>
        </div>

        <ul className="admin-list" data-warning-threshold-list>
          {(query.data?.thresholds ?? []).map((threshold) => (
            <li key={threshold.id} data-warning-threshold={threshold.id}>
              <strong>
                {t("staff.warnings.threshold.summary", {
                  points: threshold.points,
                  action: actionLabel(t, threshold.action),
                })}
              </strong>
              {threshold.durationHours === null ? null : (
                <span className="widget-muted">
                  {t("staff.warnings.threshold.hours", { hours: threshold.durationHours })}
                </span>
              )}
              <button
                type="button"
                className="button-danger"
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate({ kind: "threshold", action: "delete", id: threshold.id })
                }
              >
                {t("staff.warnings.delete")}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
