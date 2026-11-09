import { formatDate, LOCALES, type Locale, type Translator } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api.ts";

interface OverrideKeyView {
  readonly key: string;
  readonly base: string;
  readonly values: Readonly<Record<Locale, string>>;
  readonly overrides: Partial<Record<Locale, string>>;
}

interface ActiveOverride {
  readonly locale: Locale;
  readonly key: string;
  readonly value: string;
  readonly shipped: string;
  readonly updatedBy: string | null;
  readonly updatedAt: string;
}

const STRING_FORM: FormDefinition = {
  id: "string-overrides",
  submitLabelKey: "staff.strings.save",
  sections: [
    {
      id: "locales",
      titleKey: "staff.strings.formTitle",
      descriptionKey: "staff.strings.formDescription",
      fields: [
        {
          id: "en",
          type: "text",
          labelKey: "staff.strings.locale.en",
          multiline: true,
        },
        {
          id: "es",
          type: "text",
          labelKey: "staff.strings.locale.es",
          multiline: true,
        },
        {
          id: "fr",
          type: "text",
          labelKey: "staff.strings.locale.fr",
          multiline: true,
        },
      ],
    },
  ],
};

function stringValue(values: FormValues, locale: Locale): string {
  const value = values[locale];
  return typeof value === "string" ? value : "";
}

function localeLabel(t: Translator, locale: Locale): string {
  switch (locale) {
    case "en":
      return t("staff.strings.locale.en");
    case "es":
      return t("staff.strings.locale.es");
    case "fr":
      return t("staff.strings.locale.fr");
  }
}

export function StringOverridesPage() {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [values, setValues] = useState<FormValues>({});
  const [revertTarget, setRevertTarget] = useState<ActiveOverride | null>(null);

  const keysQuery = useQuery({
    queryKey: ["staff", "i18n", "keys", submittedSearch],
    queryFn: () =>
      apiGet<{ keys: OverrideKeyView[] }>(
        `/api/staff/i18n/keys?query=${encodeURIComponent(submittedSearch)}`,
      ),
  });
  const overridesQuery = useQuery({
    queryKey: ["staff", "i18n", "overrides"],
    queryFn: () => apiGet<{ overrides: ActiveOverride[] }>("/api/staff/i18n/overrides"),
  });
  const selected = keysQuery.data?.keys.find((candidate) => candidate.key === selectedKey) ?? null;

  useEffect(() => {
    if (selected === null) {
      setValues({});
      return;
    }

    setValues({
      en: selected.overrides.en ?? "",
      es: selected.overrides.es ?? "",
      fr: selected.overrides.fr ?? "",
    });
  }, [selected]);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["staff", "i18n", "keys"] }),
      queryClient.invalidateQueries({ queryKey: ["staff", "i18n", "overrides"] }),
    ]);
  };

  const save = useMutation({
    mutationFn: (formValues: FormValues) =>
      apiPost<{ ok: true }>("/api/staff/i18n/overrides", {
        key: selectedKey,
        values: {
          en: stringValue(formValues, "en"),
          es: stringValue(formValues, "es"),
          fr: stringValue(formValues, "fr"),
        },
      }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.strings.saved", tone: "success" });
      void refresh();
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.strings.saveError", tone: "error" });
    },
  });

  const revert = useMutation({
    mutationFn: (target: ActiveOverride) =>
      apiDelete<{ ok: true }>(
        `/api/staff/i18n/overrides?locale=${target.locale}&key=${encodeURIComponent(target.key)}`,
      ),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.strings.reverted", tone: "success" });
      setRevertTarget(null);
      void refresh();
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.strings.revertError", tone: "error" });
    },
  });

  const columns: readonly DataTableColumn<ActiveOverride>[] = [
    {
      id: "key",
      headerKey: "staff.strings.key",
      cell: (entry) => <span className="log-action">{entry.key}</span>,
      sortValue: (entry) => entry.key,
    },
    {
      id: "locale",
      headerKey: "staff.strings.locale",
      cell: (entry) => localeLabel(t, entry.locale),
      sortValue: (entry) => entry.locale,
    },
    {
      id: "value",
      headerKey: "staff.strings.value",
      cell: (entry) => <span className="override-value">{entry.value}</span>,
    },
    {
      id: "updatedBy",
      headerKey: "staff.strings.updatedBy",
      cell: (entry) => entry.updatedBy ?? t("staff.dashboard.log.system"),
      sortValue: (entry) => entry.updatedBy,
    },
    {
      id: "updatedAt",
      headerKey: "staff.strings.updatedAt",
      cell: (entry) =>
        formatDate(new Date(entry.updatedAt), locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      sortValue: (entry) => entry.updatedAt,
    },
  ];

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSubmittedSearch(search);
  };

  return (
    <div className="page" data-page="string-overrides">
      <header className="page-header">
        <h1>{t("staff.strings.title")}</h1>
        <p>{t("staff.strings.intro")}</p>
      </header>

      <form className="strings-search" onSubmit={submitSearch} data-strings-search-form>
        <label className="control">
          <span>{t("staff.strings.searchLabel")}</span>
          <input
            type="search"
            data-strings-search
            value={search}
            placeholder={t("staff.strings.searchPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button type="submit" data-strings-search-button>
          {t("staff.strings.search")}
        </button>
      </form>

      <div className="strings-layout">
        <aside className="strings-results" aria-label={t("staff.strings.results")}>
          {keysQuery.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
          {keysQuery.isError ? (
            <p className="widget-error">{t("staff.strings.searchError")}</p>
          ) : null}
          {keysQuery.isSuccess && keysQuery.data.keys.length === 0 ? (
            <p className="widget-muted">{t("staff.strings.noKeys")}</p>
          ) : null}
          <ul data-key-results>
            {keysQuery.data?.keys.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className={
                    entry.key === selectedKey ? "key-result key-result-active" : "key-result"
                  }
                  data-key-result={entry.key}
                  onClick={() => setSelectedKey(entry.key)}
                >
                  <span className="key-name">{entry.key}</span>
                  <span className="key-base">{entry.base}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="strings-editor" data-selected-key={selected?.key ?? "none"}>
          {selected === null ? (
            <p className="widget-muted">{t("staff.strings.chooseKey")}</p>
          ) : (
            <>
              <h2>{selected.key}</h2>
              <dl className="shipped-values" data-shipped-values>
                {LOCALES.map((entryLocale) => (
                  <div key={entryLocale}>
                    <dt>{localeLabel(t, entryLocale)}</dt>
                    <dd>{selected.values[entryLocale]}</dd>
                  </div>
                ))}
              </dl>
              <FormRenderer
                definition={STRING_FORM}
                values={values}
                onChange={setValues}
                onSubmit={(next) => save.mutate(next)}
                submitting={save.isPending}
              />
            </>
          )}
        </section>
      </div>

      <section className="strings-active" aria-labelledby="active-overrides-title">
        <h2 id="active-overrides-title">{t("staff.strings.activeTitle")}</h2>
        {overridesQuery.isPending ? (
          <p className="widget-muted">{t("staff.widget.loading")}</p>
        ) : null}
        {overridesQuery.isError ? (
          <div className="widget-error" role="alert">
            <p>{t("staff.strings.activeError")}</p>
            <button type="button" onClick={() => void overridesQuery.refetch()}>
              {t("staff.widget.retry")}
            </button>
          </div>
        ) : null}
        {overridesQuery.isSuccess ? (
          <DataTable
            rows={overridesQuery.data.overrides}
            columns={columns}
            getRowId={(entry) => `${entry.locale}::${entry.key}`}
            getRowLabel={(entry) => `${entry.key} (${entry.locale})`}
            pageSize={20}
            emptyKey="staff.strings.noOverrides"
            rowActions={(entry) => (
              <button
                type="button"
                data-revert={`${entry.locale}::${entry.key}`}
                onClick={() => setRevertTarget(entry)}
              >
                {t("staff.strings.revert")}
              </button>
            )}
          />
        ) : null}
      </section>

      <ConfirmDialog
        open={revertTarget !== null}
        titleKey="staff.strings.revertTitle"
        bodyKey="staff.strings.revertBody"
        confirmLabelKey="staff.strings.revertConfirm"
        cancelLabelKey="ui.dialog.cancel"
        tone="danger"
        busy={revert.isPending}
        onCancel={() => setRevertTarget(null)}
        onConfirm={() => {
          if (revertTarget !== null) {
            revert.mutate(revertTarget);
          }
        }}
      />
    </div>
  );
}
