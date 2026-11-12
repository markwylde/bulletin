import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

  return (
    <div className="page" data-page="filters">
      <header className="page-header">
        <h1>{t("staff.filters.title")}</h1>
        <p>{t("staff.filters.intro")}</p>
      </header>

      <section className="admin-panel">
        <h2>{t("staff.filters.words.title")}</h2>
        <div className="admin-form" data-filter-word-form>
          <label>
            <span>{t("staff.filters.word")}</span>
            <input
              data-filter-word
              value={word}
              maxLength={120}
              onChange={(event) => setWord(event.target.value)}
            />
          </label>
          <label>
            <span>{t("staff.filters.mode")}</span>
            <select
              data-filter-mode
              value={mode}
              onChange={(event) => setMode(event.target.value as WordRecord["mode"])}
            >
              <option value="block">{t("staff.filters.mode.block")}</option>
              <option value="replace">{t("staff.filters.mode.replace")}</option>
            </select>
          </label>
          {mode === "replace" ? (
            <label>
              <span>{t("staff.filters.replacement")}</span>
              <input
                data-filter-replacement
                value={replacement}
                maxLength={120}
                onChange={(event) => setReplacement(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            <span>{t("staff.filters.match")}</span>
            <select
              data-filter-match
              value={matchMode}
              onChange={(event) => setMatchMode(event.target.value as WordRecord["matchMode"])}
            >
              <option value="whole">{t("staff.filters.match.whole")}</option>
              <option value="any">{t("staff.filters.match.any")}</option>
            </select>
          </label>
          <div className="admin-form__actions">
            <button
              type="button"
              data-filter-word-save
              disabled={mutate.isPending}
              onClick={saveWord}
            >
              {t("staff.filters.save")}
            </button>
          </div>
        </div>
        <ul className="admin-list" data-filter-word-list>
          {(query.data?.words ?? []).map((record) => (
            <li key={record.id} data-filter-word-row={record.id}>
              <strong>{record.word}</strong>
              <span className="widget-muted">
                {record.mode === "block"
                  ? t("staff.filters.mode.block")
                  : t("staff.filters.mode.replace")}
                {record.mode === "replace" ? ` → ${record.replacement}` : ""} ·{" "}
                {record.matchMode === "whole"
                  ? t("staff.filters.match.whole")
                  : t("staff.filters.match.any")}
              </span>
              <button
                type="button"
                className="button-quiet"
                onClick={() => mutate.mutate({ kind: "word", action: "delete", id: record.id })}
              >
                {t("staff.filters.delete")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel">
        <h2>{t("staff.filters.domains.title")}</h2>
        <div className="admin-form" data-filter-domain-form>
          <label>
            <span>{t("staff.filters.domain")}</span>
            <input
              data-filter-domain
              value={domain}
              maxLength={200}
              onChange={(event) => setDomain(event.target.value)}
            />
          </label>
          <div className="admin-form__actions">
            <button
              type="button"
              data-filter-domain-save
              disabled={mutate.isPending}
              onClick={saveDomain}
            >
              {t("staff.filters.save")}
            </button>
          </div>
        </div>
        <ul className="admin-list" data-filter-domain-list>
          {(query.data?.domains ?? []).map((record) => (
            <li key={record.id} data-filter-domain-row={record.id}>
              <strong>{record.domain}</strong>
              <button
                type="button"
                className="button-quiet"
                onClick={() => mutate.mutate({ kind: "domain", action: "delete", id: record.id })}
              >
                {t("staff.filters.delete")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel">
        <h2>{t("staff.filters.spam.title")}</h2>
        {settings === null ? (
          <p className="widget-muted">{t("staff.widget.loading")}</p>
        ) : (
          <div className="admin-form" data-filter-spam-form>
            <label>
              <input
                type="checkbox"
                data-filter-duplicate-enabled
                checked={settings.duplicateEnabled}
                onChange={(event) =>
                  setSpam({ ...settings, duplicateEnabled: event.target.checked })
                }
              />
              <span>{t("staff.filters.spam.duplicate")}</span>
            </label>
            <label>
              <span>{t("staff.filters.spam.duplicateCount")}</span>
              <input
                data-filter-duplicate-count
                type="number"
                min={2}
                max={100}
                value={settings.duplicateCount}
                onChange={(event) =>
                  setSpam({ ...settings, duplicateCount: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t("staff.filters.spam.duplicateWindow")}</span>
              <input
                data-filter-duplicate-window
                type="number"
                min={1}
                max={1440}
                value={settings.duplicateWindowMinutes}
                onChange={(event) =>
                  setSpam({ ...settings, duplicateWindowMinutes: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                data-filter-rate-enabled
                checked={settings.rateEnabled}
                onChange={(event) => setSpam({ ...settings, rateEnabled: event.target.checked })}
              />
              <span>{t("staff.filters.spam.rate")}</span>
            </label>
            <label>
              <span>{t("staff.filters.spam.rateCount")}</span>
              <input
                data-filter-rate-count
                type="number"
                min={2}
                max={1000}
                value={settings.rateCount}
                onChange={(event) =>
                  setSpam({ ...settings, rateCount: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t("staff.filters.spam.rateMinutes")}</span>
              <input
                data-filter-rate-minutes
                type="number"
                min={1}
                max={1440}
                value={settings.rateMinutes}
                onChange={(event) =>
                  setSpam({ ...settings, rateMinutes: Number(event.target.value) })
                }
              />
            </label>
            <div className="admin-form__actions">
              <button
                type="button"
                data-filter-spam-save
                disabled={mutate.isPending}
                onClick={saveSettings}
              >
                {t("staff.filters.save")}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
