import {
  type GroupSettingDefinition,
  type RegistrySection,
  SECTION_LABEL_KEYS,
} from "@bulletin/domain/permissions";
import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { apiGet, apiPost } from "../api.ts";
import {
  Button,
  EmptyState,
  Field,
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
import { displayedSettingValue, durationUnitKey, parsedSettingValue } from "./settings.ts";

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

const NO_GROUPS: GroupSettings["groups"] = [];
const NO_DEFINITIONS: GroupSettings["definitions"] = [];

function SettingControl({
  definition,
  group,
  id,
  describedBy,
  value,
  onChange,
}: {
  readonly definition: GroupSettingDefinition;
  readonly group: GroupSettings["groups"][number];
  readonly id: string;
  readonly describedBy: string | undefined;
  readonly value: string | boolean;
  readonly onChange: (value: string | boolean) => void;
}) {
  const t = useT();
  const unitKey = durationUnitKey(definition);
  const hook = `${group.key}:${definition.key}`;

  const input =
    definition.type === "bool" ? (
      <Switch
        id={id}
        aria-describedby={describedBy}
        data-setting-cell={hook}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    ) : definition.type === "enum" ? (
      <Select
        id={id}
        aria-describedby={describedBy}
        data-setting-cell={hook}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        {(definition.values ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    ) : (
      <TextInput
        id={id}
        aria-describedby={describedBy}
        type="number"
        min={0}
        data-setting-cell={hook}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );

  return (
    <span className="setting-cell">
      {input}
      {unitKey === null ? null : (
        <span className="muted" data-duration-unit={definition.unit ?? "seconds"}>
          {t(unitKey)}
        </span>
      )}
    </span>
  );
}

export function GroupSettingsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const query = useQuery({
    queryKey: ["staff", "groups", "settings"],
    queryFn: () => apiGet<GroupSettings>("/api/staff/groups/settings"),
  });
  const extensionQuery = useQuery({
    queryKey: ["staff", "plugins", "extensions", "acp.groups.settings"],
    queryFn: () =>
      apiGet<{ sections: readonly { pluginId: string; definition: FormDefinition }[] }>(
        "/api/staff/plugins/extensions?point=acp.groups.settings",
      ),
  });
  const groups = query.data?.groups ?? NO_GROUPS;
  const definitions = query.data?.definitions ?? NO_DEFINITIONS;
  const group = groups.find((candidate) => candidate.key === params.get("group")) ?? groups[0];
  const initial = useMemo(
    () =>
      Object.fromEntries(
        definitions.map((definition) => [
          definition.key,
          displayedSettingValue(definition, group?.settings[definition.key]),
        ]),
      ) as Record<string, string | boolean>,
    [definitions, group],
  );
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    setDrafts(initial);
  }, [initial]);

  const dirtyKeys = definitions
    .map((definition) => definition.key)
    .filter((key) => drafts[key] !== undefined && drafts[key] !== initial[key]);
  const save = useMutation({
    mutationFn: async () => {
      if (group === undefined) {
        return;
      }

      for (const definition of definitions) {
        const draft = drafts[definition.key];

        if (draft === undefined || draft === initial[definition.key]) {
          continue;
        }

        await apiPost("/api/staff/groups", {
          action: "setting",
          groupId: group.id,
          key: definition.key,
          value: parsedSettingValue(definition, draft),
        });
      }
    },
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.groups.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "groups", "settings"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.groups.saveError", tone: "error" }),
  });

  const sections = new Map<RegistrySection, GroupSettingDefinition[]>();

  for (const definition of definitions) {
    const list = sections.get(definition.section) ?? [];
    list.push(definition);
    sections.set(definition.section, list);
  }

  return (
    <Page
      id="group-settings"
      title={t("staff.groups.settings.title")}
      description={t("staff.groups.settings.intro")}
      width="narrow"
    >
      <QueryState query={query} errorLabel={t("staff.groups.loadError")}>
        {() =>
          group === undefined ? (
            <EmptyState title={t("staff.groups.empty")} />
          ) : (
            <>
              <Panel>
                <div className="toolbar-filters">
                  <Field label={t("staff.groups.settings.group")}>
                    {({ id }) => (
                      <Select
                        id={id}
                        data-setting-group
                        value={group.key}
                        onChange={(event) =>
                          setParams({ group: event.target.value }, { replace: true })
                        }
                      >
                        {groups.map((candidate) => (
                          <option key={candidate.id} value={candidate.key}>
                            {candidate.title}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              </Panel>

              {[...sections.entries()].map(([section, list]) => (
                <SettingsSection
                  key={section}
                  data-setting-section={section}
                  title={t(SECTION_LABEL_KEYS[section])}
                >
                  {list.map((definition) => (
                    <div
                      key={definition.key}
                      className="settings-row-item"
                      data-setting-row={definition.key}
                    >
                      <SettingsRow
                        label={t(definition.labelKey)}
                        description={t(mergeLabelKey(definition.merge))}
                      >
                        {({ id, describedBy }) => (
                          <SettingControl
                            definition={definition}
                            group={group}
                            id={id}
                            describedBy={describedBy}
                            value={drafts[definition.key] ?? initial[definition.key] ?? ""}
                            onChange={(value) =>
                              setDrafts((current) => ({ ...current, [definition.key]: value }))
                            }
                          />
                        )}
                      </SettingsRow>
                    </div>
                  ))}
                </SettingsSection>
              ))}

              <SaveBar
                dirty={dirtyKeys.length > 0}
                message={t("staff.unsavedChanges")}
                data-settings-dirty={dirtyKeys.length}
              >
                {dirtyKeys.length > 0 ? (
                  <Button variant="ghost" onClick={() => setDrafts(initial)}>
                    {t("staff.discard")}
                  </Button>
                ) : null}
                <Button
                  variant="primary"
                  data-settings-save
                  disabled={save.isPending || dirtyKeys.length === 0}
                  onClick={() => save.mutate()}
                >
                  {t("staff.groups.save")}
                </Button>
              </SaveBar>
            </>
          )
        }
      </QueryState>

      {/* Plugin extension sections render below every core section; core fields are untouched. */}
      {(extensionQuery.data?.sections ?? []).map((section) => (
        <PluginExtensionForm
          key={section.pluginId}
          pluginId={section.pluginId}
          definition={section.definition}
        />
      ))}
    </Page>
  );
}

function PluginExtensionForm({
  pluginId,
  definition,
}: {
  readonly pluginId: string;
  readonly definition: FormDefinition;
}) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["staff", "plugins", pluginId, "settings"],
    queryFn: () =>
      apiGet<{ values: FormValues }>(`/api/staff/plugins/settings?pluginId=${pluginId}`),
  });
  const [values, setValues] = useState<FormValues>({});
  const save = useMutation({
    mutationFn: (next: FormValues) =>
      apiPost("/api/staff/plugins/settings", { pluginId, values: next }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.plugins.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "groups", "settings"] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.plugins.saveFailed", tone: "error" }),
  });

  useEffect(() => {
    if (query.data !== undefined) {
      setValues(query.data.values);
    }
  }, [query.data]);

  return (
    <Panel data-plugin-setting-section={pluginId} description={t("staff.plugins.extension.note")}>
      <FormRenderer
        definition={definition}
        values={values}
        onChange={setValues}
        onSubmit={(next) => save.mutate(next)}
        submitting={save.isPending}
      />
    </Panel>
  );
}
