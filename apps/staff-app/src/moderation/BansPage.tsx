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
  FormActions,
  Page,
  Panel,
  Table,
  TextInput,
} from "../ui/index.ts";

interface IpBan {
  readonly id: string;
  readonly cidr: string;
  readonly reason: string;
  readonly expiresAt: string | null;
}

interface BansResponse {
  readonly ips: readonly IpBan[];
}

interface IpLookup {
  readonly ip?: string | null;
  readonly expired?: boolean;
  readonly members?: readonly {
    readonly memberId: string;
    readonly displayName: string | null;
    readonly postId: string;
    readonly createdAt: string;
  }[];
  readonly logins?: readonly { readonly ip: string; readonly createdAt: string }[];
}

export function BansPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [cidr, setCidr] = useState("");
  const [ipReason, setIpReason] = useState("");
  const [ipDays, setIpDays] = useState(365);
  const [memberId, setMemberId] = useState("");
  const [memberReason, setMemberReason] = useState("");
  const [memberDays, setMemberDays] = useState(0);
  const [postId, setPostId] = useState("");
  const [lookup, setLookup] = useState<IpLookup | null>(null);
  const [lookupMember, setLookupMember] = useState("");
  const [loginIps, setLoginIps] = useState<IpLookup | null>(null);
  const query = useQuery({
    queryKey: ["staff", "bans"],
    queryFn: () => apiGet<BansResponse>("/api/staff/bans"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/bans", body),
    onSuccess: async () => {
      toast.pushToast({ messageKey: "staff.bans.saved", tone: "success" });
      await queryClient.invalidateQueries({ queryKey: ["staff", "bans"] });
    },
  });

  const grant = async (
    purpose: "post_ip" | "reverse_ip" | "login_ips",
    resourceType: "post" | "member",
    resourceId: string,
  ): Promise<string | null> => {
    try {
      const body = await apiPost<{ readonly grantId?: string }>("/api/staff/ips/open", {
        purpose,
        resourceType,
        resourceId,
      });
      return body.grantId ?? null;
    } catch {
      return null;
    }
  };

  const read = async (
    grantId: string,
    kind: "post" | "members" | "logins",
  ): Promise<IpLookup | null> => {
    try {
      return await apiPost<IpLookup>("/api/staff/ips/read", { grantId, kind });
    } catch {
      return null;
    }
  };

  const lookupPost = async (kind: "post" | "members"): Promise<void> => {
    const grantId = await grant(kind === "post" ? "post_ip" : "reverse_ip", "post", postId);

    if (grantId === null) {
      setLookup({ expired: true });
      return;
    }

    setLookup(await read(grantId, kind));
  };

  const lookupLogins = async (): Promise<void> => {
    const grantId = await grant("login_ips", "member", lookupMember);

    if (grantId === null) {
      setLoginIps({ logins: [] });
      return;
    }

    setLoginIps(await read(grantId, "logins"));
  };

  const field = (
    label: string,
    hook: string,
    value: string | number,
    set: (value: string) => void,
    options: { type?: string; max?: number; placeholder?: string; maxLength?: number } = {},
  ) => (
    <Field label={label}>
      {({ id }) => (
        <TextInput
          id={id}
          {...{ [hook]: true }}
          type={options.type}
          min={options.type === "number" ? 0 : undefined}
          max={options.max}
          maxLength={options.maxLength}
          placeholder={options.placeholder}
          value={value}
          onChange={(event) => set(event.target.value)}
        />
      )}
    </Field>
  );

  return (
    <Page id="bans" title={t("staff.bans.title")} description={t("staff.bans.intro")}>
      <Panel flush title={t("staff.bans.ip.title")}>
        <form
          className="toolbar"
          data-ip-ban-form
          onSubmit={(event) => {
            event.preventDefault();
            mutate.mutate({ action: "ip.save", cidr, reason: ipReason, days: ipDays });
          }}
        >
          <div className="toolbar-filters">
            {field(t("staff.bans.ip.cidr"), "data-ip-ban-cidr", cidr, setCidr, {
              placeholder: t("staff.bans.ip.example"),
            })}
            {field(t("staff.bans.reason"), "data-ip-ban-reason", ipReason, setIpReason, {
              maxLength: 500,
            })}
            {field(
              t("staff.bans.days"),
              "data-ip-ban-days",
              ipDays,
              (value) => setIpDays(Number(value)),
              {
                type: "number",
                max: 3650,
              },
            )}
            <Button type="submit" variant="primary" data-ip-ban-save disabled={mutate.isPending}>
              {t("staff.bans.save")}
            </Button>
          </div>
        </form>
        <div data-ip-ban-list>
          <Table
            caption={t("staff.bans.ip.title")}
            rows={query.data?.ips ?? []}
            rowKey={(ban) => ban.id}
            rowProps={(ban) => ({ "data-ip-ban-row": ban.id })}
            empty={<EmptyState title={t("staff.bans.ip.empty")} />}
            columns={[
              {
                id: "cidr",
                header: t("staff.bans.ip.cidr"),
                primary: true,
                cell: (ban) => <code>{ban.cidr}</code>,
              },
              {
                id: "reason",
                header: t("staff.bans.reason"),
                cell: (ban) => <span className="break">{ban.reason}</span>,
              },
              {
                id: "expires",
                header: t("staff.bans.expires"),
                cell: (ban) =>
                  ban.expiresAt === null ? (
                    <Badge tone="danger">{t("staff.bans.permanent")}</Badge>
                  ) : (
                    <time dateTime={ban.expiresAt} className="muted">
                      {new Date(ban.expiresAt).toLocaleDateString()}
                    </time>
                  ),
              },
              {
                id: "actions",
                header: t("staff.rowActions"),
                align: "end",
                cell: (ban) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-ip-ban-remove
                    disabled={mutate.isPending}
                    onClick={() => mutate.mutate({ action: "ip.remove", id: ban.id })}
                  >
                    {t("staff.bans.remove")}
                  </Button>
                ),
              },
            ]}
          />
        </div>
      </Panel>

      <div className="page-split page-split-even">
        <Panel title={t("staff.bans.member.title")}>
          <div className="stack" data-member-ban-form>
            {field(t("staff.bans.member.id"), "data-member-ban-id", memberId, setMemberId)}
            {field(
              t("staff.bans.reason"),
              "data-member-ban-reason",
              memberReason,
              setMemberReason,
              {
                maxLength: 500,
              },
            )}
            {field(
              t("staff.bans.days"),
              "data-member-ban-days",
              memberDays,
              (value) => setMemberDays(Number(value)),
              { type: "number", max: 3650 },
            )}
            <p className="field-description">{t("staff.bans.member.daysHelp")}</p>
            <FormActions>
              <Button
                variant="ghost"
                data-member-ban-unban
                disabled={mutate.isPending}
                onClick={() => mutate.mutate({ action: "member.unban", memberId })}
              >
                {t("staff.bans.member.unban")}
              </Button>
              <Button
                variant="primary"
                data-member-ban-save
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate({
                    action: "member.ban",
                    memberId,
                    reason: memberReason,
                    days: memberDays,
                  })
                }
              >
                {t("staff.bans.save")}
              </Button>
            </FormActions>
          </div>
        </Panel>

        <Panel title={t("staff.bans.lookup.title")} description={t("staff.bans.lookup.audited")}>
          <div className="stack">
            <div className="toolbar-filters">
              {field(t("staff.bans.lookup.postId"), "data-ip-lookup-post", postId, setPostId)}
              <Button data-ip-lookup-view onClick={() => void lookupPost("post")}>
                {t("staff.bans.lookup.postIp")}
              </Button>
              <Button data-ip-lookup-reverse onClick={() => void lookupPost("members")}>
                {t("staff.bans.lookup.reverse")}
              </Button>
            </div>
            {lookup === null ? null : (
              <div className="lookup-result" data-ip-lookup-result>
                {lookup.expired ? (
                  <p className="muted">{t("staff.bans.lookup.expired")}</p>
                ) : lookup.ip !== undefined ? (
                  <code>{lookup.ip}</code>
                ) : (
                  <ul className="plain-list">
                    {(lookup.members ?? []).map((member) => (
                      <li key={`${member.memberId}-${member.postId}`}>
                        {member.displayName ?? t("staff.moderation.deletedAuthor")}{" "}
                        <span className="subtle">#{member.postId}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <hr className="divider" />
            <div className="toolbar-filters">
              {field(
                t("staff.bans.lookup.memberId"),
                "data-login-ip-member",
                lookupMember,
                setLookupMember,
              )}
              <Button data-login-ip-lookup onClick={() => void lookupLogins()}>
                {t("staff.bans.lookup.loginIps")}
              </Button>
            </div>
            {loginIps === null ? null : (
              <ul className="lookup-result plain-list" data-login-ip-result>
                {(loginIps.logins ?? []).map((login) => (
                  <li key={`${login.ip}-${login.createdAt}`}>
                    <code>{login.ip}</code>{" "}
                    <span className="subtle">{new Date(login.createdAt).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>
    </Page>
  );
}
