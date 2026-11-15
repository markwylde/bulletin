import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  IconPlus,
  IconTrash,
  Page,
  Panel,
  QueryState,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  Switch,
  TextInput,
} from "../ui/index.ts";

interface WordRecord {
  readonly id: string;
  readonly word: string;
  readonly mode: "block" | "replace";
  readonly replacement: string;
  readonly matchMode: "whole" | "any";
  readonly enabled: boolean;
}

interface DomainRecord {
  readonly id: string;
  readonly domain: string;
  readonly enabled: boolean;
}

interface SpamSettings {
  readonly duplicateEnabled: boolean;
  readonly duplicateCount: number;
  readonly duplicateWindowMinutes: number;
  readonly rateEnabled: boolean;
  readonly rateCount: number;
  readonly rateMinutes: number;
}

interface FilterSettings {
  readonly words: readonly WordRecord[];
  readonly domains: readonly DomainRecord[];
  readonly settings: SpamSettings;
}

export function FiltersPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [word, setWord] = useState("");
  const [mode, setMode] = useState<WordRecord["mode"]>("block");
  const [replacement, setReplacement] = useState("");
  const [matchMode, setMatchMode] = useState<WordRecord["matchMode"]>("whole");
  const [domain, setDomain] = useState("");
  const [spam, setSpam] = useState<SpamSettings | null>(null);
  const query = useQuery({
    queryKey: ["staff", "filters"],
    queryFn: () => apiGet<FilterSettings>("/api/staff/filters"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/filters", body),
    onSuccess: async () => {
      toast.pushToast({ messageKey: "staff.filters.saved", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: ["staff", "filters"] });
    },
  });
  const settings = spam ?? query.data?.settings ?? null;

  const saveWord = (): void => {
    mutate.mutate({
      kind: "word",
      action: "save",
      word,
      mode,
      replacement,
      matchMode,
      enabled: true,
    });
    setWord("");
    setReplacement("");
  };

  const saveDomain = (): void => {
    mutate.mutate({ kind: "domain", action: "save", domain, enabled: true });
    setDomain("");
  };

  const saveSettings = (): void => {
    if (settings !== null) {
      mutate.mutate({ kind: "settings", action: "save", ...settings });
    }
  };

  const words = query.data?.words ?? [];
  const domains = query.data?.domains ?? [];
  const spamDirty =
    spam !== null &&
    query.data !== undefined &&
    JSON.stringify(spam) !== JSON.stringify(query.data.settings);
  const numberRow = (
    label: string,
    hook: string,
    field: "duplicateCount" | "duplicateWindowMinutes" | "rateCount" | "rateMinutes",
    min: number,
    max: number,
    current: SpamSettings,
  ) => (
    <SettingsRow label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [hook]: true }}
          type="number"
          min={min}
          max={max}
          className="input-narrow"
          value={current[field]}
          onChange={(event) => setSpam({ ...current, [field]: Number(event.target.value) })}
        />
      )}
    </SettingsRow>
  );

  return (
    <Page id="filters" title={t("staff.filters.title")} description={t("staff.filters.intro")}>
      <Panel flush title={t("staff.filters.words.title")}>
        <form
          className="toolbar"
          data-filter-word-form
          onSubmit={(event) => {
            event.preventDefault();
            saveWord();
          }}
        >
          <div className="toolbar-filters">
            <Field label={t("staff.filters.word")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  data-filter-word
                  value={word}
                  maxLength={120}
                  onChange={(event) => setWord(event.target.value)}
                />
              )}
            </Field>
            <Field label={t("staff.filters.mode")}>
              {({ id }) => (
                <Select
                  id={id}
                  data-filter-mode
                  value={mode}
                  onChange={(event) => setMode(event.target.value as WordRecord["mode"])}
                >
                  <option value="block">{t("staff.filters.mode.block")}</option>
                  <option value="replace">{t("staff.filters.mode.replace")}</option>
                </Select>
              )}
            </Field>
            {mode === "replace" ? (
              <Field label={t("staff.filters.replacement")}>
                {({ id }) => (
                  <TextInput
                    id={id}
                    data-filter-replacement
                    value={replacement}
                    maxLength={120}
                    onChange={(event) => setReplacement(event.target.value)}
                  />
                )}
              </Field>
            ) : null}
            <Field label={t("staff.filters.match")}>
              {({ id }) => (
                <Select
                  id={id}
                  data-filter-match
                  value={matchMode}
                  onChange={(event) => setMatchMode(event.target.value as WordRecord["matchMode"])}
                >
                  <option value="whole">{t("staff.filters.match.whole")}</option>
                  <option value="any">{t("staff.filters.match.any")}</option>
                </Select>
              )}
            </Field>
            <Button
              type="submit"
              variant="primary"
              icon={<IconPlus size={16} />}
              data-filter-word-save
              disabled={mutate.isPending}
            >
              {t("staff.filters.add")}
            </Button>
          </div>
        </form>
        {words.length === 0 ? <EmptyState title={t("staff.filters.words.empty")} /> : null}
        <ul className="list" data-filter-word-list>
          {words.map((record) => (
            <li key={record.id} className="list-row" data-filter-word-row={record.id}>
              <div className="list-row-main">
                <span className="list-row-title">
                  <code>{record.word}</code>
                  {record.mode === "replace" ? (
                    <>
                      {" → "}
                      <code>{record.replacement}</code>
                    </>
                  ) : null}
                </span>
                <span className="list-row-meta">
                  {record.matchMode === "whole"
                    ? t("staff.filters.match.whole")
                    : t("staff.filters.match.any")}
                </span>
              </div>
              <Badge tone={record.mode === "block" ? "danger" : "neutral"}>
                {record.mode === "block"
                  ? t("staff.filters.mode.block")
                  : t("staff.filters.mode.replace")}
              </Badge>
              <div className="list-row-actions">
                <IconButton
                  size="sm"
                  label={t("staff.filters.delete")}
                  data-filter-word-delete={record.id}
                  onClick={() => mutate.mutate({ kind: "word", action: "delete", id: record.id })}
                >
                  <IconTrash size={16} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel flush title={t("staff.filters.domains.title")}>
        <form
          className="toolbar"
          data-filter-domain-form
          onSubmit={(event) => {
            event.preventDefault();
            saveDomain();
          }}
        >
          <div className="toolbar-filters">
            <Field label={t("staff.filters.domain")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  data-filter-domain
                  value={domain}
                  maxLength={200}
                  placeholder={t("staff.filters.domains.placeholder")}
                  onChange={(event) => setDomain(event.target.value)}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="primary"
              icon={<IconPlus size={16} />}
              data-filter-domain-save
              disabled={mutate.isPending}
            >
              {t("staff.filters.add")}
            </Button>
          </div>
        </form>
        {domains.length === 0 ? <EmptyState title={t("staff.filters.domains.empty")} /> : null}
        <ul className="list" data-filter-domain-list>
          {domains.map((record) => (
            <li key={record.id} className="list-row" data-filter-domain-row={record.id}>
              <div className="list-row-main">
                <code className="list-row-title break">{record.domain}</code>
              </div>
              <div className="list-row-actions">
                <IconButton
                  size="sm"
                  label={t("staff.filters.delete")}
                  data-filter-domain-delete={record.id}
                  onClick={() => mutate.mutate({ kind: "domain", action: "delete", id: record.id })}
                >
                  <IconTrash size={16} />
                </IconButton>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      {settings === null ? (
        <QueryState query={query} errorLabel={t("staff.filters.loadError")}>
          {() => null}
        </QueryState>
      ) : (
        <>
          <SettingsSection title={t("staff.filters.spam.title")} data-filter-spam-form>
            <SettingsRow label={t("staff.filters.spam.duplicate")}>
              {({ id }) => (
                <Switch
                  id={id}
                  data-filter-duplicate-enabled
                  checked={settings.duplicateEnabled}
                  onChange={(event) =>
                    setSpam({ ...settings, duplicateEnabled: event.target.checked })
                  }
                />
              )}
            </SettingsRow>
            {numberRow(
              t("staff.filters.spam.duplicateCount"),
              "data-filter-duplicate-count",
              "duplicateCount",
              2,
              100,
              settings,
            )}
            {numberRow(
              t("staff.filters.spam.duplicateWindow"),
              "data-filter-duplicate-window",
              "duplicateWindowMinutes",
              1,
              1440,
              settings,
            )}
            <SettingsRow label={t("staff.filters.spam.rate")}>
              {({ id }) => (
                <Switch
                  id={id}
                  data-filter-rate-enabled
                  checked={settings.rateEnabled}
                  onChange={(event) => setSpam({ ...settings, rateEnabled: event.target.checked })}
                />
              )}
            </SettingsRow>
            {numberRow(
              t("staff.filters.spam.rateCount"),
              "data-filter-rate-count",
              "rateCount",
              2,
              1000,
              settings,
            )}
            {numberRow(
              t("staff.filters.spam.rateMinutes"),
              "data-filter-rate-minutes",
              "rateMinutes",
              1,
              1440,
              settings,
            )}
          </SettingsSection>
          <SaveBar dirty={spamDirty} message={t("staff.unsavedChanges")}>
            {spamDirty ? (
              <Button variant="ghost" onClick={() => setSpam(null)}>
                {t("staff.discard")}
              </Button>
            ) : null}
            <Button
              variant="primary"
              data-filter-spam-save
              disabled={mutate.isPending}
              onClick={saveSettings}
            >
              {t("staff.filters.save")}
            </Button>
          </SaveBar>
        </>
      )}
    </Page>
  );
}
