import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

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

  return (
    <div className="page" data-page="bans">
      <header className="page-header">
        <h1>{t("staff.bans.title")}</h1>
        <p>{t("staff.bans.intro")}</p>
      </header>

      <section className="admin-panel">
        <h2>{t("staff.bans.ip.title")}</h2>
        <div className="admin-form" data-ip-ban-form>
          <label>
            <span>{t("staff.bans.ip.cidr")}</span>
            <input
              data-ip-ban-cidr
              value={cidr}
              onChange={(event) => setCidr(event.target.value)}
              placeholder={t("staff.bans.ip.example")}
            />
          </label>
          <label>
            <span>{t("staff.bans.reason")}</span>
            <input
              data-ip-ban-reason
              value={ipReason}
              maxLength={500}
              onChange={(event) => setIpReason(event.target.value)}
            />
          </label>
          <label>
            <span>{t("staff.bans.days")}</span>
            <input
              data-ip-ban-days
              type="number"
              min={0}
              max={3650}
              value={ipDays}
              onChange={(event) => setIpDays(Number(event.target.value))}
            />
          </label>
          <div className="admin-form__actions">
            <button
              type="button"
              data-ip-ban-save
              disabled={mutate.isPending}
              onClick={() =>
                mutate.mutate({
                  action: "ip.save",
                  cidr,
                  reason: ipReason,
                  days: ipDays,
                })
              }
            >
              {t("staff.bans.save")}
            </button>
          </div>
        </div>
        <ul className="admin-list" data-ip-ban-list>
          {(query.data?.ips ?? []).map((ban) => (
            <li key={ban.id} data-ip-ban-row={ban.id}>
              <strong>{ban.cidr}</strong>
              <span className="widget-muted">{ban.reason}</span>
              <span className="widget-muted">
                {ban.expiresAt === null
                  ? t("staff.bans.permanent")
                  : new Date(ban.expiresAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                className="button-danger"
                onClick={() => mutate.mutate({ action: "ip.remove", id: ban.id })}
              >
                {t("staff.bans.remove")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel">
        <h2>{t("staff.bans.member.title")}</h2>
        <div className="admin-form" data-member-ban-form>
          <label>
            <span>{t("staff.bans.member.id")}</span>
            <input
              data-member-ban-id
              value={memberId}
              onChange={(event) => setMemberId(event.target.value)}
            />
          </label>
          <label>
            <span>{t("staff.bans.reason")}</span>
            <input
              data-member-ban-reason
              value={memberReason}
              maxLength={500}
              onChange={(event) => setMemberReason(event.target.value)}
            />
          </label>
          <label>
            <span>{t("staff.bans.days")}</span>
            <input
              data-member-ban-days
              type="number"
              min={0}
              max={3650}
              value={memberDays}
              onChange={(event) => setMemberDays(Number(event.target.value))}
            />
          </label>
          <div className="admin-form__actions">
            <button
              type="button"
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
            </button>
            <button
              type="button"
              className="button-quiet"
              data-member-ban-unban
              disabled={mutate.isPending}
              onClick={() => mutate.mutate({ action: "member.unban", memberId })}
            >
              {t("staff.bans.member.unban")}
            </button>
          </div>
        </div>
      </section>

      <section className="admin-panel">
        <h2>{t("staff.bans.lookup.title")}</h2>
        <div className="admin-form">
          <label>
            <span>{t("staff.bans.lookup.postId")}</span>
            <input
              data-ip-lookup-post
              value={postId}
              onChange={(event) => setPostId(event.target.value)}
            />
          </label>
          <div className="admin-form__actions">
            <button type="button" data-ip-lookup-view onClick={() => void lookupPost("post")}>
              {t("staff.bans.lookup.postIp")}
            </button>
            <button type="button" data-ip-lookup-reverse onClick={() => void lookupPost("members")}>
              {t("staff.bans.lookup.reverse")}
            </button>
          </div>
          {lookup === null ? null : (
            <div data-ip-lookup-result>
              {lookup.expired ? (
                <p>{t("staff.bans.lookup.expired")}</p>
              ) : lookup.ip !== undefined ? (
                <p>{lookup.ip}</p>
              ) : (
                <ul>
                  {(lookup.members ?? []).map((member) => (
                    <li key={`${member.memberId}-${member.postId}`}>
                      {member.displayName ?? t("staff.moderation.deletedAuthor")} · {member.postId}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="admin-form">
          <label>
            <span>{t("staff.bans.lookup.memberId")}</span>
            <input
              data-login-ip-member
              value={lookupMember}
              onChange={(event) => setLookupMember(event.target.value)}
            />
          </label>
          <div className="admin-form__actions">
            <button type="button" data-login-ip-lookup onClick={() => void lookupLogins()}>
              {t("staff.bans.lookup.loginIps")}
            </button>
          </div>
          {loginIps === null ? null : (
            <ul data-login-ip-result>
              {(loginIps.logins ?? []).map((login) => (
                <li key={`${login.ip}-${login.createdAt}`}>
                  {login.ip} · {new Date(login.createdAt).toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
