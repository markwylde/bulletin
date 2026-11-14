import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface PrivacyRetention {
  readonly ipLogDays: number;
  readonly sessionMetaDays: number;
  readonly revokedSessionDays: number;
  readonly accessLogDays: number;
  readonly exportDays: number;
  readonly ipBanDays: number;
}

const EMPTY_VALUES: FormValues = {
  ipLogDays: 90,
  sessionMetaDays: 30,
  revokedSessionDays: 7,
  accessLogDays: 730,
  exportDays: 7,
  ipBanDays: 365,
};

const RETENTION_FORM: FormDefinition = {
  id: "privacy-retention",
  submitLabelKey: "staff.privacy.retention.save",
  sections: [
    {
      id: "restricted",
      titleKey: "staff.privacy.retention.section.restricted",
      descriptionKey: "staff.privacy.retention.section.restrictedHelp",
      fields: [
        {
          id: "ipLogDays",
          type: "number",
          labelKey: "staff.privacy.retention.ipLogs",
          helpKey: "staff.privacy.retention.ipLogsHelp",
          min: 1,
          max: 3_650,
        },
        {
          id: "sessionMetaDays",
          type: "number",
          labelKey: "staff.privacy.retention.sessionMeta",
          helpKey: "staff.privacy.retention.sessionMetaHelp",
          min: 1,
          max: 3_650,
        },
        {
          id: "accessLogDays",
          type: "number",
          labelKey: "staff.privacy.retention.accessLog",
          helpKey: "staff.privacy.retention.accessLogHelp",
          min: 1,
          max: 3_650,
        },
        {
          id: "exportDays",
          type: "number",
          labelKey: "staff.privacy.retention.exports",
          helpKey: "staff.privacy.retention.exportsHelp",
          min: 1,
          max: 3_650,
        },
      ],
    },
    {
      id: "core",
      titleKey: "staff.privacy.retention.section.core",
      descriptionKey: "staff.privacy.retention.section.coreHelp",
      fields: [
        {
          id: "revokedSessionDays",
          type: "number",
          labelKey: "staff.privacy.retention.revokedSessions",
          helpKey: "staff.privacy.retention.revokedSessionsHelp",
          min: 1,
          max: 3_650,
        },
        {
          id: "ipBanDays",
          type: "number",
          labelKey: "staff.privacy.retention.ipBans",
          helpKey: "staff.privacy.retention.ipBansHelp",
          min: 1,
          max: 3_650,
        },
      ],
    },
  ],
};

function toValues(settings: PrivacyRetention): FormValues {
  return {
    ipLogDays: settings.ipLogDays,
    sessionMetaDays: settings.sessionMetaDays,
    revokedSessionDays: settings.revokedSessionDays,
    accessLogDays: settings.accessLogDays,
    exportDays: settings.exportDays,
    ipBanDays: settings.ipBanDays,
  };
}

function toPayload(values: FormValues): PrivacyRetention {
  const days = (field: keyof PrivacyRetention, fallback: number): number =>
    typeof values[field] === "number" ? values[field] : Number(values[field] ?? fallback);

  return {
    ipLogDays: days("ipLogDays", 90),
    sessionMetaDays: days("sessionMetaDays", 30),
    revokedSessionDays: days("revokedSessionDays", 7),
    accessLogDays: days("accessLogDays", 730),
    exportDays: days("exportDays", 7),
    ipBanDays: days("ipBanDays", 365),
  };
}

export function RetentionPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const query = useQuery({
    queryKey: ["staff", "privacy", "retention"],
    queryFn: () => apiGet<PrivacyRetention>("/api/staff/privacy/retention"),
  });
  const mutation = useMutation({
    mutationFn: (payload: PrivacyRetention) =>
      apiPost<PrivacyRetention>("/api/staff/privacy/retention", payload),
    onSuccess: (data) => {
      setValues(toValues(data));
      queryClient.setQueryData(["staff", "privacy", "retention"], data);
      toast.pushToast({ messageKey: "staff.privacy.retention.saved", tone: "success" });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.privacy.retention.error", tone: "error" });
    },
  });

  useEffect(() => {
    if (query.data !== undefined) {
      setValues(toValues(query.data));
    }
  }, [query.data]);

  return (
    <div className="page" data-page="privacy-retention">
      <header className="page-header">
        <h1>{t("staff.privacy.retention.title")}</h1>
        <p>{t("staff.privacy.retention.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.privacy.retention.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <FormRenderer
          definition={RETENTION_FORM}
          values={values}
          onChange={setValues}
          onSubmit={(next) => mutation.mutate(toPayload(next))}
          submitting={mutation.isPending}
        />
      ) : null}
    </div>
  );
}
