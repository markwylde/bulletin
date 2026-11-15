import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Button,
  Page,
  QueryState,
  SaveBar,
  SettingsRow,
  SettingsSection,
  TextInput,
} from "../ui/index.ts";

interface PrivacyRetention {
  readonly ipLogDays: number;
  readonly sessionMetaDays: number;
  readonly revokedSessionDays: number;
  readonly accessLogDays: number;
  readonly exportDays: number;
  readonly ipBanDays: number;
}

type RetentionKey = keyof PrivacyRetention;

interface RetentionField {
  readonly id: RetentionKey;
  readonly labelKey: string;
  readonly helpKey: string;
}

const SECTIONS: ReadonlyArray<{
  readonly id: string;
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly fields: readonly RetentionField[];
}> = [
  {
    id: "restricted",
    titleKey: "staff.privacy.retention.section.restricted",
    descriptionKey: "staff.privacy.retention.section.restrictedHelp",
    fields: [
      {
        id: "ipLogDays",
        labelKey: "staff.privacy.retention.ipLogs",
        helpKey: "staff.privacy.retention.ipLogsHelp",
      },
      {
        id: "sessionMetaDays",
        labelKey: "staff.privacy.retention.sessionMeta",
        helpKey: "staff.privacy.retention.sessionMetaHelp",
      },
      {
        id: "accessLogDays",
        labelKey: "staff.privacy.retention.accessLog",
        helpKey: "staff.privacy.retention.accessLogHelp",
      },
      {
        id: "exportDays",
        labelKey: "staff.privacy.retention.exports",
        helpKey: "staff.privacy.retention.exportsHelp",
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
        labelKey: "staff.privacy.retention.revokedSessions",
        helpKey: "staff.privacy.retention.revokedSessionsHelp",
      },
      {
        id: "ipBanDays",
        labelKey: "staff.privacy.retention.ipBans",
        helpKey: "staff.privacy.retention.ipBansHelp",
      },
    ],
  },
];

const KEYS: readonly RetentionKey[] = SECTIONS.flatMap((section) =>
  section.fields.map((field) => field.id),
);

type Drafts = Record<RetentionKey, string>;

function toDrafts(settings: PrivacyRetention): Drafts {
  return Object.fromEntries(KEYS.map((key) => [key, String(settings[key])])) as Drafts;
}

function isValid(value: string): boolean {
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 3_650;
}

export function RetentionPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const query = useQuery({
    queryKey: ["staff", "privacy", "retention"],
    queryFn: () => apiGet<PrivacyRetention>("/api/staff/privacy/retention"),
  });
  const mutation = useMutation({
    mutationFn: (payload: PrivacyRetention) =>
      apiPost<PrivacyRetention>("/api/staff/privacy/retention", payload),
    onSuccess: (data) => {
      setDrafts(toDrafts(data));
      queryClient.setQueryData(["staff", "privacy", "retention"], data);
      toast.pushToast({ messageKey: "staff.privacy.retention.saved", tone: "success" });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.privacy.retention.error", tone: "error" });
    },
  });

  useEffect(() => {
    if (query.data !== undefined) {
      setDrafts(toDrafts(query.data));
    }
  }, [query.data]);

  const initial = query.data === undefined ? null : toDrafts(query.data);
  const dirty =
    drafts !== null && initial !== null && KEYS.some((key) => drafts[key] !== initial[key]);
  const valid = drafts !== null && KEYS.every((key) => isValid(drafts[key]));

  return (
    <Page
      id="privacy-retention"
      width="narrow"
      title={t("staff.privacy.retention.title")}
      description={t("staff.privacy.retention.intro")}
    >
      <QueryState query={query} errorLabel={t("staff.privacy.retention.loadError")}>
        {() =>
          drafts === null ? null : (
            <form
              className="stack"
              data-retention-form
              onSubmit={(event) => {
                event.preventDefault();

                if (valid) {
                  mutation.mutate(
                    Object.fromEntries(
                      KEYS.map((key) => [key, Number(drafts[key])]),
                    ) as unknown as PrivacyRetention,
                  );
                }
              }}
            >
              {SECTIONS.map((section) => (
                <SettingsSection
                  key={section.id}
                  title={t(section.titleKey)}
                  description={t(section.descriptionKey)}
                >
                  {section.fields.map((field) => (
                    <SettingsRow
                      key={field.id}
                      label={t(field.labelKey)}
                      description={t(field.helpKey)}
                      error={
                        isValid(drafts[field.id]) ? undefined : t("staff.privacy.retention.range")
                      }
                    >
                      {({ id, describedBy }) => (
                        <span className="input-suffix">
                          <TextInput
                            id={id}
                            aria-describedby={describedBy}
                            className="input-narrow"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={3_650}
                            data-retention-field={field.id}
                            value={drafts[field.id]}
                            onChange={(event) =>
                              setDrafts((current) =>
                                current === null
                                  ? current
                                  : { ...current, [field.id]: event.target.value },
                              )
                            }
                          />
                          <span className="subtle">{t("staff.privacy.retention.days")}</span>
                        </span>
                      )}
                    </SettingsRow>
                  ))}
                </SettingsSection>
              ))}
              <SaveBar dirty={dirty} message={t("staff.unsavedChanges")}>
                {dirty && initial !== null ? (
                  <Button variant="ghost" onClick={() => setDrafts(initial)}>
                    {t("staff.discard")}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  data-retention-save
                  disabled={mutation.isPending || !dirty || !valid}
                >
                  {t("staff.privacy.retention.save")}
                </Button>
              </SaveBar>
            </form>
          )
        }
      </QueryState>
    </Page>
  );
}
