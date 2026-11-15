import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { Button, Checkbox, Page, QueryState, SaveBar, SettingsSection } from "../ui/index.ts";
import { MemberLookup } from "./MemberLookup.tsx";

interface MemberGroups {
  readonly member: { id: string; displayName: string | null };
  readonly primaryGroupId: string | null;
  readonly groups: ReadonlyArray<{
    id: string;
    key: string;
    title: string;
    isPrimary: boolean;
  }>;
  readonly allGroups: ReadonlyArray<{ id: string; key: string; title: string }>;
}

export function MemberGroupsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const [memberId, setMemberId] = useState<string | null>(null);
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState<readonly string[]>([]);
  const query = useQuery({
    queryKey: ["staff", "member-groups", memberId],
    queryFn: () => apiGet<MemberGroups>(`/api/staff/groups/member?memberId=${memberId ?? ""}`),
    enabled: memberId !== null,
  });
  const save = useMutation({
    mutationFn: () =>
      apiPost<{ ok: true }>("/api/staff/groups/member", {
        memberId,
        primaryGroupId: primary,
        secondaryGroupIds: secondary,
      }),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.memberGroups.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "member-groups", memberId] });
    },
    onError: () => toast.pushToast({ messageKey: "staff.memberGroups.saveError", tone: "error" }),
  });

  const dirty =
    query.data !== undefined &&
    (primary !== (query.data.primaryGroupId ?? "") ||
      [...secondary].sort().join() !==
        query.data.groups
          .filter((group) => !group.isPrimary)
          .map((group) => group.id)
          .sort()
          .join());

  useEffect(() => {
    if (query.data !== undefined) {
      setPrimary(query.data.primaryGroupId ?? "");
      setSecondary(query.data.groups.filter((group) => !group.isPrimary).map((group) => group.id));
    }
  }, [query.data]);

  return (
    <Page
      id="member-groups"
      title={t("staff.memberGroups.title")}
      description={t("staff.memberGroups.intro")}
      width="narrow"
    >
      <MemberLookup
        label={t("staff.memberGroups.memberId")}
        loadLabel={t("staff.memberGroups.load")}
        value={input}
        onChange={setInput}
        onLoad={setMemberId}
        inputProps={{ "data-member-id": true }}
        buttonProps={{ "data-member-load": true }}
      />

      {memberId === null ? null : (
        <QueryState query={query} errorLabel={t("staff.memberGroups.loadError")}>
          {(data) => (
            <>
              <SettingsSection
                data-member-groups
                title={data.member.displayName ?? `#${data.member.id}`}
                description={t("staff.memberGroups.member")}
              >
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="field-label" id="member-primary-group">
                      {t("staff.memberGroups.primary")}
                    </span>
                  </div>
                  <fieldset
                    className="settings-row-control field-group"
                    aria-labelledby="member-primary-group"
                  >
                    {data.allGroups.map((group) => (
                      <label key={group.id} className="checkbox">
                        <input
                          type="radio"
                          name="primary-group"
                          data-member-primary={group.key}
                          checked={primary === group.id}
                          onChange={() => {
                            setPrimary(group.id);
                            setSecondary((current) => current.filter((id) => id !== group.id));
                          }}
                        />
                        <span className="checkbox-text">
                          <span className="checkbox-label">{group.title}</span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </div>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <span className="field-label" id="member-secondary-groups">
                      {t("staff.memberGroups.secondary")}
                    </span>
                  </div>
                  <fieldset
                    className="settings-row-control field-group"
                    aria-labelledby="member-secondary-groups"
                  >
                    {data.allGroups
                      .filter((group) => group.id !== primary)
                      .map((group) => (
                        <Checkbox
                          key={group.id}
                          label={group.title}
                          data-member-secondary={group.key}
                          checked={secondary.includes(group.id)}
                          onChange={(event) =>
                            setSecondary((current) =>
                              event.target.checked
                                ? [...current, group.id]
                                : current.filter((id) => id !== group.id),
                            )
                          }
                        />
                      ))}
                  </fieldset>
                </div>
              </SettingsSection>
              <SaveBar dirty={dirty} message={t("staff.unsavedChanges")}>
                <Button
                  variant="primary"
                  data-member-save
                  disabled={save.isPending || primary === ""}
                  onClick={() => save.mutate()}
                >
                  {t("staff.memberGroups.save")}
                </Button>
              </SaveBar>
            </>
          )}
        </QueryState>
      )}
    </Page>
  );
}
