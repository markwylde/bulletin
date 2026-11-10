import {
  type GroupSettingDefinition,
  type RegistrySection,
  SECTION_LABEL_KEYS,
} from "@bulletin/domain/permissions";
import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface GroupSettings {
  readonly groups: ReadonlyArray<{
    id: string;
    key: string;
    title: string;
    settings: Readonly<Record<string, unknown>>;
  }>;
  readonly definitions: readonly GroupSettingDefinition[];
}

const MERGE_LABELS = {
  "allow-any": { labelKey: "staff.groups.merge.allowAny" },
  "restrict-any": { labelKey: "staff.groups.merge.restrictAny" },
  max: { labelKey: "staff.groups.merge.max" },
  min: { labelKey: "staff.groups.merge.min" },
  primary: { labelKey: "staff.groups.merge.primary" },
} as const;

function mergeLabelKey(merge: GroupSettingDefinition["merge"]): string {
  return MERGE_LABELS[merge].labelKey;
}

function displayValue(definition: GroupSettingDefinition, value: unknown): string | boolean {
  if (definition.type === "bool") {
    return value === true;
  }

  if (typeof value === "number" || typeof value === "string") {
    return String(value);
  }

  return String(definition.defaultValue);
}

function parsedValue(
  definition: GroupSettingDefinition,
  raw: string | boolean,
): boolean | number | string {
  if (definition.type === "bool") {
    return raw === true;
  }

  if (definition.type === "int" || definition.type === "duration") {
    return Number(raw);
  }

  return String(raw);
}

function SettingCell({
  definition,
  group,
  value,
  onSave,
}: {
  readonly definition: GroupSettingDefinition;
  readonly group: GroupSettings["groups"][number];
  readonly value: unknown;
  readonly onSave: (value: boolean | number | string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | boolean>(() => displayValue(definition, value));

  useEffect(() => {
    setDraft(displayValue(definition, value));
  }, [definition, value]);

  const input =
    definition.type === "bool" ? (
      <input
        type="checkbox"
        data-setting-cell={`${group.key}:${definition.key}`}
        checked={draft === true}
        onChange={(event) => setDraft(event.target.checked)}
      />
    ) : definition.type === "enum" ? (
      <select
        data-setting-cell={`${group.key}:${definition.key}`}
        value={String(draft)}
        onChange={(event) => setDraft(event.target.value)}
      >
        {(definition.values ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : (
      <input
        type="number"
        min={0}
        data-setting-cell={`${group.key}:${definition.key}`}
        value={String(draft)}
        onChange={(event) => setDraft(event.target.value)}
      />
    );

  return (
    <span className="setting-cell">
      {input}
      {definition.type === "duration" ? (
        <span className="widget-muted">{t("staff.groups.seconds")}</span>
      ) : null}
      <button
        type="button"
        data-setting-save={`${group.key}:${definition.key}`}
        onClick={() => onSave(parsedValue(definition, draft))}
      >
        {t("staff.groups.cellSave")}
      </button>
    </span>
  );
}

export function GroupSettingsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["staff", "groups", "settings"],
    queryFn: () => apiGet<GroupSettings>("/api/staff/groups/settings"),
  });
  const save = useMutation({
    mutationFn: (body: { groupId: string; key: string; value: unknown }) =>
      apiPost("/api/staff/groups", { action: "setting", ...body }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.groups.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "groups", "settings"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.groups.saveError", tone: "error" }),
  });

  const sections = new Map<RegistrySection, GroupSettingDefinition[]>();

  for (const definition of query.data?.definitions ?? []) {
    const list = sections.get(definition.section) ?? [];
    list.push(definition);
    sections.set(definition.section, list);
  }

  return (
    <div className="page" data-page="group-settings">
      <header className="page-header">
        <h1>{t("staff.groups.settings.title")}</h1>
        <p>{t("staff.groups.settings.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.groups.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess
        ? [...sections.entries()].map(([section, definitions]) => (
            <section
              key={section}
              className="admin-panel"
              data-setting-section={section}
              aria-labelledby={`settings-section-${section}`}
            >
              <h2 id={`settings-section-${section}`}>{t(SECTION_LABEL_KEYS[section])}</h2>
              <div className="matrix-scroll">
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th scope="col">{t("staff.groups.settings.setting")}</th>
                      {query.data.groups.map((group) => (
                        <th key={group.id} scope="col">
                          {group.title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {definitions.map((definition) => (
                      <tr key={definition.key} data-setting-row={definition.key}>
                        <th scope="row">
                          <span>{t(definition.labelKey)}</span>
                          <span className="section-detail">
                            {t(mergeLabelKey(definition.merge))}
                          </span>
                        </th>
                        {query.data.groups.map((group) => (
                          <td key={group.id}>
                            <SettingCell
                              definition={definition}
                              group={group}
                              value={group.settings[definition.key]}
                              onSave={(value) =>
                                save.mutate({
                                  groupId: group.id,
                                  key: definition.key,
                                  value,
                                })
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        : null}
    </div>
  );
}
