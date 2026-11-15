import { useLocale, useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Page,
  Panel,
  QueryState,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  Textarea,
  TextInput,
} from "../ui/index.ts";
import { MemberLookup } from "./MemberLookup.tsx";

interface FieldOptionView {
  readonly value: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface MemberFieldView {
  readonly id: string;
  readonly type: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly required: boolean;
  readonly value: string | number | readonly string[] | null;
  readonly options: readonly FieldOptionView[];
}

interface StaffMemberBadgeView {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly awarded: boolean;
  readonly featured: boolean;
}

interface MemberProfileView {
  readonly memberId: string;
  readonly displayName: string;
  readonly about: string;
  readonly hideOnline: boolean;
  readonly hideFromMemberList: boolean;
  readonly fields: readonly MemberFieldView[];
}

function emptyValue(field: MemberFieldView): string | readonly string[] {
  if (field.type === "multiselect") {
    return Array.isArray(field.value) ? field.value.map(String) : [];
  }

  if (field.value === null) {
    return "";
  }

  return typeof field.value === "string" || typeof field.value === "number"
    ? String(field.value)
    : "";
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  readonly field: MemberFieldView;
  readonly value: string | readonly string[];
  readonly onChange: (value: string | readonly string[]) => void;
}) {
  const t = useT();
  const locale = useLocale();

  if (field.type === "multiselect") {
    const selected = new Set(Array.isArray(value) ? value : []);

    return (
      <div className="stack stack-sm">
        {field.options.map((option) => (
          <label className="checkbox" key={option.value}>
            <input
              type="checkbox"
              value={option.value}
              data-profile-value-option={field.id}
              checked={selected.has(option.value)}
              onChange={(event) => {
                const next = new Set(selected);

                if (event.target.checked) {
                  next.add(option.value);
                } else {
                  next.delete(option.value);
                }

                onChange([...next]);
              }}
            />
            <span>{option.labels[locale] ?? option.labels.en ?? option.value}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <Select
        data-profile-value={field.id}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t("staff.memberProfiles.choose")}</option>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.labels[locale] ?? option.labels.en ?? option.value}
          </option>
        ))}
      </Select>
    );
  }

  if (field.type === "long_text") {
    return (
      <Textarea
        data-profile-value={field.id}
        rows={4}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const inputType =
    field.type === "number"
      ? "number"
      : field.type === "date"
        ? "date"
        : field.type === "url"
          ? "url"
          : "text";

  return (
    <TextInput
      type={inputType}
      data-profile-value={field.id}
      step={field.type === "number" ? "any" : undefined}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function MemberProfilesPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [memberId, setMemberId] = useState("");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [about, setAbout] = useState("");
  const [hideOnline, setHideOnline] = useState(false);
  const [hideFromMemberList, setHideFromMemberList] = useState(false);
  const [values, setValues] = useState<Record<string, string | readonly string[]>>({});
  const [badgeReason, setBadgeReason] = useState("");
  const query = useQuery({
    queryKey: ["staff", "member-profile", loadedId],
    queryFn: () =>
      apiGet<MemberProfileView>(
        `/api/staff/members/profile?memberId=${encodeURIComponent(loadedId ?? "")}`,
      ),
    enabled: loadedId !== null,
  });
  const badgeQuery = useQuery({
    queryKey: ["staff", "member-badges", loadedId],
    queryFn: () =>
      apiGet<{ badges: readonly StaffMemberBadgeView[] }>(
        `/api/staff/members/badges?memberId=${encodeURIComponent(loadedId ?? "")}`,
      ),
    enabled: loadedId !== null,
  });
  const badgeMutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/members/badges", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.memberProfiles.badgeSaved", tone: "success" });
      void badgeQuery.refetch();
    },
    onError: () =>
      toast.pushToast({ messageKey: "staff.memberProfiles.badgeError", tone: "error" }),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/members/profile", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.memberProfiles.saved", tone: "success" });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.memberProfiles.saveError", tone: "error" });
    },
  });

  useEffect(() => {
    if (!query.isSuccess) {
      return;
    }

    setAbout(query.data.about);
    setHideOnline(query.data.hideOnline);
    setHideFromMemberList(query.data.hideFromMemberList);
    setValues(Object.fromEntries(query.data.fields.map((field) => [field.id, emptyValue(field)])));
  }, [query.data, query.isSuccess]);

  const save = (): void => {
    if (!query.isSuccess) {
      return;
    }

    const bodyValues: Record<string, unknown> = {};

    for (const field of query.data.fields) {
      const value = values[field.id];

      if (field.type === "number") {
        const text = typeof value === "string" ? value.trim() : "";
        bodyValues[field.id] = text === "" ? "" : Number(text);
      } else {
        bodyValues[field.id] = value ?? "";
      }
    }

    mutate.mutate({
      memberId: query.data.memberId,
      about,
      hideOnline,
      hideFromMemberList,
      values: bodyValues,
    });
  };

  const initialValues = query.isSuccess
    ? Object.fromEntries(query.data.fields.map((field) => [field.id, emptyValue(field)]))
    : {};
  const dirty =
    query.isSuccess &&
    (about !== query.data.about ||
      hideOnline !== query.data.hideOnline ||
      hideFromMemberList !== query.data.hideFromMemberList ||
      JSON.stringify(values) !== JSON.stringify(initialValues));
  const reset = (): void => {
    if (!query.isSuccess) {
      return;
    }

    setAbout(query.data.about);
    setHideOnline(query.data.hideOnline);
    setHideFromMemberList(query.data.hideFromMemberList);
    setValues(initialValues);
  };

  return (
    <Page
      id="member-profiles"
      title={t("staff.memberProfiles.title")}
      description={t("staff.memberProfiles.intro")}
      width="narrow"
    >
      <MemberLookup
        label={t("staff.memberProfiles.memberId")}
        loadLabel={t("staff.memberProfiles.load")}
        value={memberId}
        onChange={setMemberId}
        onLoad={(id) => {
          if (id !== null) {
            setLoadedId(id);
          }
        }}
        inputProps={{ "data-profile-member-id": true }}
        buttonProps={{ "data-profile-member-load": true }}
      />

      {loadedId === null ? null : (
        <QueryState query={query} errorLabel={t("staff.memberProfiles.loadError")}>
          {(profile) => (
            <>
              <SettingsSection title={<span data-profile-display-name>{profile.displayName}</span>}>
                <SettingsRow label={t("staff.memberProfiles.about")}>
                  {({ id }) => (
                    <Textarea
                      id={id}
                      data-profile-about
                      rows={6}
                      maxLength={20000}
                      value={about}
                      onChange={(event) => setAbout(event.target.value)}
                    />
                  )}
                </SettingsRow>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="field-label">{t("staff.memberProfiles.privacy")}</span>
                  </div>
                  <div className="settings-row-control">
                    <Checkbox
                      data-profile-hide-online
                      checked={hideOnline}
                      onChange={(event) => setHideOnline(event.target.checked)}
                      label={t("staff.memberProfiles.hideOnline")}
                    />
                    <Checkbox
                      data-profile-hide-from-list
                      checked={hideFromMemberList}
                      onChange={(event) => setHideFromMemberList(event.target.checked)}
                      label={t("staff.memberProfiles.hideFromList")}
                    />
                  </div>
                </div>
              </SettingsSection>

              {profile.fields.length > 0 ? (
                <SettingsSection title={t("staff.memberProfiles.fields")}>
                  {profile.fields.map((field) => (
                    <div className="settings-row" key={field.id} data-profile-field={field.id}>
                      <div className="settings-row-text">
                        <span className="field-label">
                          {field.labels[locale] ?? field.labels.en ?? ""}
                          {field.required ? " *" : ""}
                        </span>
                      </div>
                      <div className="settings-row-control">
                        <FieldInput
                          field={field}
                          value={values[field.id] ?? emptyValue(field)}
                          onChange={(value) =>
                            setValues((current) => ({ ...current, [field.id]: value }))
                          }
                        />
                      </div>
                    </div>
                  ))}
                </SettingsSection>
              ) : null}

              <SaveBar dirty={dirty} message={t("staff.unsavedChanges")}>
                {dirty ? (
                  <Button variant="ghost" onClick={reset}>
                    {t("staff.discard")}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  data-profile-save
                  disabled={mutate.isPending}
                  onClick={save}
                >
                  {t("staff.memberProfiles.save")}
                </Button>
              </SaveBar>

              {badgeQuery.isSuccess ? (
                <Panel title={t("staff.memberProfiles.badges")} flush>
                  <div className="toolbar">
                    <div className="toolbar-filters">
                      <Field label={t("staff.memberProfiles.badgeReason")}>
                        {({ id }) => (
                          <TextInput
                            id={id}
                            data-badge-reason
                            value={badgeReason}
                            onChange={(event) => setBadgeReason(event.target.value)}
                          />
                        )}
                      </Field>
                    </div>
                  </div>
                  <ul className="list">
                    {badgeQuery.data.badges.map((badge) => (
                      <li key={badge.id} className="list-row" data-member-badge={badge.id}>
                        <div className="list-row-main">
                          <span className="list-row-title">{badge.label}</span>
                        </div>
                        {badge.awarded ? (
                          <Badge tone="success">{t("staff.memberProfiles.awarded")}</Badge>
                        ) : null}
                        <div className="list-row-actions">
                          <Button
                            size="sm"
                            variant={badge.awarded ? "ghost" : "secondary"}
                            data-member-badge-action={badge.awarded ? "revoke" : "award"}
                            onClick={() =>
                              badgeMutate.mutate({
                                memberId: profile.memberId,
                                badgeId: badge.id,
                                action: badge.awarded ? "revoke" : "award",
                                reason: badgeReason,
                              })
                            }
                          >
                            {badge.awarded
                              ? t("staff.memberProfiles.revokeBadge")
                              : t("staff.memberProfiles.awardBadge")}
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}
            </>
          )}
        </QueryState>
      )}
    </Page>
  );
}
