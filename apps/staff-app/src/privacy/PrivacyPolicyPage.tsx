import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface PrivacyPolicy {
  readonly markdown: string;
  readonly html: string;
  readonly updatedAt: string | null;
}

export function PrivacyPolicyPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [markdown, setMarkdown] = useState("");
  const query = useQuery({
    queryKey: ["staff", "privacy", "policy"],
    queryFn: () => apiGet<PrivacyPolicy>("/api/staff/privacy/policy"),
  });
  const mutation = useMutation({
    mutationFn: (value: string) =>
      apiPost<PrivacyPolicy>("/api/staff/privacy/policy", { markdown: value }),
    onSuccess: (data) => {
      setMarkdown(data.markdown);
      queryClient.setQueryData(["staff", "privacy", "policy"], data);
      toast.pushToast({ messageKey: "staff.privacy.policy.saved", tone: "success" });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.privacy.policy.error", tone: "error" });
    },
  });

  useEffect(() => {
    if (query.data !== undefined) {
      setMarkdown(query.data.markdown);
    }
  }, [query.data]);

  return (
    <div className="page" data-page="privacy-policy">
      <header className="page-header">
        <h1>{t("staff.privacy.policy.title")}</h1>
        <p>{t("staff.privacy.policy.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.privacy.policy.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <form
          className="admin-form"
          data-policy-form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(markdown);
          }}
        >
          <label>
            <span>{t("staff.privacy.policy.markdown")}</span>
            <textarea
              data-policy-markdown
              rows={16}
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
            />
          </label>
          <p className="widget-muted">{t("staff.privacy.policy.help")}</p>
          <button type="submit" data-policy-save disabled={mutation.isPending}>
            {mutation.isPending ? t("staff.privacy.policy.saving") : t("staff.privacy.policy.save")}
          </button>
        </form>
      ) : null}
    </div>
  );
}
