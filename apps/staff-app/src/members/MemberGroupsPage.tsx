import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

  useEffect(() => {
    if (query.data !== undefined) {
      setPrimary(query.data.primaryGroupId ?? "");
      setSecondary(query.data.groups.filter((group) => !group.isPrimary).map((group) => group.id));
    }
  }, [query.data]);

  return (
    <div className="page" data-page="member-groups">
      <header className="page-header">
        <h1>{t("staff.memberGroups.title")}</h1>
        <p>{t("staff.memberGroups.intro")}</p>
      </header>

      <section className="admin-panel">
        <div className="admin-form">
          <label>
            <span>{t("staff.memberGroups.memberId")}</span>
            <input
              data-member-id
              inputMode="numeric"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <button
            type="button"
            data-member-load
            onClick={() => setMemberId(/^\d+$/.test(input.trim()) ? input.trim() : null)}
          >
            {t("staff.memberGroups.load")}
          </button>
        </div>
      </section>

      {query.isPending && memberId !== null ? (
        <p className="widget-muted">{t("staff.widget.loading")}</p>
      ) : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.memberGroups.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <section className="admin-panel" data-member-groups>
          <h2>
            {t("staff.memberGroups.member")}{" "}
            <span className="log-action">
              {query.data.member.displayName ?? `#${query.data.member.id}`}
            </span>
          </h2>
          <fieldset>
            <legend>{t("staff.memberGroups.primary")}</legend>
            <ul className="check-list">
              {query.data.allGroups.map((group) => (
                <li key={group.id}>
                  <label>
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
                    <span>{group.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <fieldset>
            <legend>{t("staff.memberGroups.secondary")}</legend>
            <ul className="check-list">
              {query.data.allGroups
                .filter((group) => group.id !== primary)
                .map((group) => (
                  <li key={group.id}>
                    <label>
                      <input
                        type="checkbox"
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
                      <span>{group.title}</span>
                    </label>
                  </li>
                ))}
            </ul>
          </fieldset>
          <button
            type="button"
            data-member-save
            disabled={save.isPending || primary === ""}
            onClick={() => save.mutate()}
          >
            {t("staff.memberGroups.save")}
          </button>
        </section>
      ) : null}
    </div>
  );
}
