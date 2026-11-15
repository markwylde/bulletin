import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import { Button, Field, Page, Panel, QueryState, SaveBar, Textarea } from "../ui/index.ts";

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

  const dirty = query.data !== undefined && markdown !== query.data.markdown;

  return (
    <Page
      id="privacy-policy"
      width="narrow"
      title={t("staff.privacy.policy.title")}
      description={t("staff.privacy.policy.intro")}
    >
      <QueryState query={query} errorLabel={t("staff.privacy.policy.loadError")}>
        {(data) => (
          <form
            className="stack"
            data-policy-form
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate(markdown);
            }}
          >
            <Panel>
              <Field
                label={t("staff.privacy.policy.markdown")}
                description={t("staff.privacy.policy.help")}
              >
                {({ id, describedBy }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    className="code-input"
                    data-policy-markdown
                    rows={18}
                    value={markdown}
                    onChange={(event) => setMarkdown(event.target.value)}
                  />
                )}
              </Field>
            </Panel>
            <SaveBar dirty={dirty} message={t("staff.unsavedChanges")}>
              {dirty ? (
                <Button variant="ghost" onClick={() => setMarkdown(data.markdown)}>
                  {t("staff.discard")}
                </Button>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                data-policy-save
                disabled={mutation.isPending}
              >
                {mutation.isPending
                  ? t("staff.privacy.policy.saving")
                  : t("staff.privacy.policy.save")}
              </Button>
            </SaveBar>
          </form>
        )}
      </QueryState>
    </Page>
  );
}
