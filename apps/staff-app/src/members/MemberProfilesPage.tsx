import { useLocale, useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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
      <div className="checkbox-list">
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
      <select
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
      </select>
    );
  }

  if (field.type === "long_text") {
    return (
      <textarea
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
    <input
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
  const query = useQuery({
    queryKey: ["staff", "member-profile", loadedId],
    queryFn: () =>
      apiGet<MemberProfileView>(
        `/api/staff/members/profile?memberId=${encodeURIComponent(loadedId ?? "")}`,
      ),
    enabled: loadedId !== null,
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

  return (
    <div className="page" data-page="member-profiles">
      <header className="page-header">
        <h1>{t("staff.memberProfiles.title")}</h1>
        <p>{t("staff.memberProfiles.intro")}</p>
      </header>

      <section className="admin-panel" aria-labelledby="member-profile-lookup-title">
        <h2 id="member-profile-lookup-title">{t("staff.memberProfiles.lookup")}</h2>
        <div className="admin-form">
          <label>
            <span>{t("staff.memberProfiles.memberId")}</span>
            <input
              inputMode="numeric"
              data-profile-member-id
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            />
          </label>
          <button
            type="button"
            data-profile-member-load
            disabled={!/^\d+$/.test(memberId)}
            onClick={() => setLoadedId(memberId)}
          >
            {t("staff.memberProfiles.load")}
          </button>
        </div>
        {query.isError ? (
          <div className="widget-error" role="alert">
            <p>{t("staff.memberProfiles.loadError")}</p>
            <button type="button" onClick={() => void query.refetch()}>
              {t("staff.widget.retry")}
            </button>
          </div>
        ) : null}
        {query.isPending && loadedId !== null ? (
          <p className="widget-muted">{t("staff.widget.loading")}</p>
        ) : null}
      </section>

      {query.isSuccess ? (
        <section className="admin-panel" aria-labelledby="member-profile-editor-title">
          <h2 id="member-profile-editor-title" data-profile-display-name>
            {query.data.displayName}
          </h2>

          <div className="admin-form">
            <label>
              <span>{t("staff.memberProfiles.about")}</span>
              <textarea
                data-profile-about
                rows={6}
                maxLength={20000}
                value={about}
                onChange={(event) => setAbout(event.target.value)}
              />
            </label>
          </div>

          <div className="admin-form">
            <label className="checkbox">
              <input
                type="checkbox"
                data-profile-hide-online
                checked={hideOnline}
                onChange={(event) => setHideOnline(event.target.checked)}
              />
              <span>{t("staff.memberProfiles.hideOnline")}</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                data-profile-hide-from-list
                checked={hideFromMemberList}
                onChange={(event) => setHideFromMemberList(event.target.checked)}
              />
              <span>{t("staff.memberProfiles.hideFromList")}</span>
            </label>
          </div>

          {query.data.fields.length > 0 ? (
            <div className="admin-form">
              <h3>{t("staff.memberProfiles.fields")}</h3>
              {query.data.fields.map((field) => (
                <div className="admin-field" key={field.id} data-profile-field={field.id}>
                  <span className="admin-field__label">
                    {field.labels[locale] ?? field.labels.en ?? ""}
                    {field.required ? " *" : ""}
                  </span>
                  <FieldInput
                    field={field}
                    value={values[field.id] ?? emptyValue(field)}
                    onChange={(value) =>
                      setValues((current) => ({ ...current, [field.id]: value }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}

          <div className="admin-form">
            <button type="button" data-profile-save disabled={mutate.isPending} onClick={save}>
              {t("staff.memberProfiles.save")}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
