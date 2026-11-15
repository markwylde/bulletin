import { formatDate, LOCALES, type Locale, type Translator } from "@bulletin/i18n";
import { useLocale, useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { DataTable, type DataTableColumn } from "@bulletin/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api.ts";
import {
  Button,
  DescriptionList,
  EmptyState,
  IconRefresh,
  Notice,
  Page,
  Panel,
  QueryState,
  SearchInput,
  Skeleton,
} from "../ui/index.ts";

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
      cell: (entry) => <code className="mono">{entry.key}</code>,
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
      cell: (entry) => <span className="break">{entry.value}</span>,
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
    <Page
      id="string-overrides"
      title={t("staff.strings.title")}
      description={t("staff.strings.intro")}
    >
      <div className="page-split">
        <Panel flush title={t("staff.strings.results")}>
          <form className="toolbar" onSubmit={submitSearch} data-strings-search-form>
            <div className="toolbar-filters">
              <SearchInput
                label={t("staff.strings.searchLabel")}
                placeholder={t("staff.strings.searchPlaceholder")}
                data-strings-search
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button type="submit" data-strings-search-button>
                {t("staff.strings.search")}
              </Button>
            </div>
          </form>
          {keysQuery.isPending ? (
            <div className="panel-pad">
              <Skeleton lines={4} label={t("staff.widget.loading")} />
            </div>
          ) : null}
          {keysQuery.isError ? (
            <Notice tone="danger" role="alert" title={t("staff.strings.searchError")} />
          ) : null}
          {keysQuery.isSuccess && keysQuery.data.keys.length === 0 ? (
            <EmptyState title={t("staff.strings.noKeys")} />
          ) : null}
          <ul className="list" data-key-results>
            {keysQuery.data?.keys.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  className={
                    entry.key === selectedKey
                      ? "list-row list-row-button is-selected"
                      : "list-row list-row-button"
                  }
                  aria-current={entry.key === selectedKey ? "true" : undefined}
                  data-key-result={entry.key}
                  onClick={() => setSelectedKey(entry.key)}
                >
                  <span className="list-row-main">
                    <span className="list-row-title mono truncate">{entry.key}</span>
                    <span className="list-row-meta truncate">{entry.base}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          title={
            selected === null ? (
              t("staff.strings.editorTitle")
            ) : (
              <code className="mono break">{selected.key}</code>
            )
          }
          data-selected-key={selected?.key ?? "none"}
        >
          {selected === null ? (
            <EmptyState title={t("staff.strings.chooseKey")} />
          ) : (
            <div className="stack">
              <DescriptionList
                data-shipped-values
                items={LOCALES.map((entryLocale) => ({
                  id: entryLocale,
                  label: localeLabel(t, entryLocale),
                  value: selected.values[entryLocale],
                }))}
              />
              <FormRenderer
                definition={STRING_FORM}
                values={values}
                onChange={setValues}
                onSubmit={(next) => save.mutate(next)}
                submitting={save.isPending}
              />
            </div>
          )}
        </Panel>
      </div>

      <Panel flush title={t("staff.strings.activeTitle")}>
        <QueryState query={overridesQuery} errorLabel={t("staff.strings.activeError")}>
          {(data) => (
            <DataTable
              rows={data.overrides}
              columns={columns}
              getRowId={(entry) => `${entry.locale}::${entry.key}`}
              getRowLabel={(entry) => `${entry.key} (${entry.locale})`}
              pageSize={20}
              emptyKey="staff.strings.noOverrides"
              rowActions={(entry) => (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<IconRefresh size={16} />}
                  data-revert={`${entry.locale}::${entry.key}`}
                  onClick={() => setRevertTarget(entry)}
                >
                  {t("staff.strings.revert")}
                </Button>
              )}
            />
          )}
        </QueryState>
      </Panel>

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
    </Page>
  );
}
