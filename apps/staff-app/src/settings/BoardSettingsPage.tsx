import { isLocale } from "@bulletin/i18n";
import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { type FormDefinition, FormRenderer, type FormValues } from "@bulletin/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface BoardSettings {
  readonly boardName: string;
  readonly boardDescription: string;
  readonly defaultLocale: "en" | "es" | "fr";
  readonly offline: boolean;
  readonly offlineMessage: string;
  readonly newMemberApprovalPosts: number;
  readonly attachmentAllowedTypes: readonly string[];
  readonly reactionsAffectReputation: boolean;
  readonly reputationDisplay: boolean;
  readonly reputationLabelScale: readonly ReputationLabel[];
  readonly apiKeyRateLimitPerMinute: number;
  readonly apiIpRateLimitPerMinute: number;
  readonly robotsTxt: string;
}

interface ReputationLabel {
  readonly min: number;
  readonly labelKey: string;
}

const REPUTATION_LABEL_FIELDS = [
  {
    id: "reputationLabelNotorious",
    key: "notorious",
    labelKey: "staff.settings.board.reputationLabel.notorious",
    fallback: -1_000_000,
  },
  {
    id: "reputationLabelDisliked",
    key: "disliked",
    labelKey: "staff.settings.board.reputationLabel.disliked",
    fallback: -100,
  },
  {
    id: "reputationLabelNeutral",
    key: "neutral",
    labelKey: "staff.settings.board.reputationLabel.neutral",
    fallback: 0,
  },
  {
    id: "reputationLabelRespected",
    key: "respected",
    labelKey: "staff.settings.board.reputationLabel.respected",
    fallback: 100,
  },
  {
    id: "reputationLabelRevered",
    key: "revered",
    labelKey: "staff.settings.board.reputationLabel.revered",
    fallback: 500,
  },
] as const;

const ATTACHMENT_TYPE_OPTIONS = [
  { value: "image/png", labelKey: "staff.settings.board.type.imagePng" },
  { value: "image/jpeg", labelKey: "staff.settings.board.type.imageJpeg" },
  { value: "image/gif", labelKey: "staff.settings.board.type.imageGif" },
  { value: "image/webp", labelKey: "staff.settings.board.type.imageWebp" },
  { value: "image/avif", labelKey: "staff.settings.board.type.imageAvif" },
  { value: "image/svg+xml", labelKey: "staff.settings.board.type.imageSvg" },
  { value: "application/pdf", labelKey: "staff.settings.board.type.pdf" },
  { value: "application/zip", labelKey: "staff.settings.board.type.zip" },
  { value: "text/plain", labelKey: "staff.settings.board.type.plainText" },
  { value: "text/html", labelKey: "staff.settings.board.type.html" },
  { value: "text/csv", labelKey: "staff.settings.board.type.csv" },
] as const;

const EMPTY_VALUES: FormValues = {
  boardName: "",
  boardDescription: "",
  defaultLocale: "en",
  offline: false,
  offlineMessage: "",
  newMemberApprovalPosts: 0,
  attachmentAllowedTypes: ATTACHMENT_TYPE_OPTIONS.map((option) => option.value),
  reactionsAffectReputation: false,
  reputationDisplay: true,
  apiKeyRateLimitPerMinute: 60,
  apiIpRateLimitPerMinute: 120,
  robotsTxt: "",
  ...Object.fromEntries(REPUTATION_LABEL_FIELDS.map((field) => [field.id, field.fallback])),
};

const BOARD_FORM: FormDefinition = {
  id: "board-settings",
  submitLabelKey: "staff.settings.board.save",
  sections: [
    {
      id: "general",
      titleKey: "staff.settings.board.section.general",
      fields: [
        {
          id: "boardName",
          type: "text",
          labelKey: "staff.settings.board.name",
          required: true,
          maxLength: 100,
        },
        {
          id: "boardDescription",
          type: "text",
          labelKey: "staff.settings.board.description",
          helpKey: "staff.settings.board.descriptionHelp",
          multiline: true,
          maxLength: 5_000,
        },
        {
          id: "defaultLocale",
          type: "select",
          labelKey: "staff.settings.board.defaultLocale",
          required: true,
          options: [
            { value: "en", labelKey: "staff.locale.en" },
            { value: "es", labelKey: "staff.locale.es" },
            { value: "fr", labelKey: "staff.locale.fr" },
          ],
        },
      ],
    },
    {
      id: "moderation",
      titleKey: "staff.settings.board.section.moderation",
      descriptionKey: "staff.settings.board.section.moderationHelp",
      fields: [
        {
          id: "newMemberApprovalPosts",
          type: "number",
          labelKey: "staff.settings.board.newMemberApprovalPosts",
          helpKey: "staff.settings.board.newMemberApprovalPostsHelp",
          min: 0,
          max: 1_000,
        },
      ],
    },
    {
      id: "attachments",
      titleKey: "staff.settings.board.section.attachments",
      descriptionKey: "staff.settings.board.section.attachmentsHelp",
      fields: [
        {
          id: "attachmentAllowedTypes",
          type: "multi-select",
          labelKey: "staff.settings.board.attachmentTypes",
          helpKey: "staff.settings.board.attachmentTypesHelp",
          options: ATTACHMENT_TYPE_OPTIONS,
        },
      ],
    },
    {
      id: "reputation",
      titleKey: "staff.settings.board.section.reputation",
      descriptionKey: "staff.settings.board.section.reputationHelp",
      fields: [
        {
          id: "reactionsAffectReputation",
          type: "toggle",
          labelKey: "staff.settings.board.reactionsAffectReputation",
          helpKey: "staff.settings.board.reactionsAffectReputationHelp",
        },
        {
          id: "reputationDisplay",
          type: "toggle",
          labelKey: "staff.settings.board.reputationDisplay",
          helpKey: "staff.settings.board.reputationDisplayHelp",
        },
        ...REPUTATION_LABEL_FIELDS.map((field) => ({
          id: field.id,
          type: "number" as const,
          labelKey: field.labelKey,
          min: -1_000_000,
          max: 1_000_000,
        })),
      ],
    },
    {
      id: "api",
      titleKey: "staff.settings.board.section.api",
      descriptionKey: "staff.settings.board.section.apiHelp",
      fields: [
        {
          id: "apiKeyRateLimitPerMinute",
          type: "number",
          labelKey: "staff.settings.board.apiKeyRateLimit",
          helpKey: "staff.settings.board.apiKeyRateLimitHelp",
          min: 1,
          max: 10_000,
        },
        {
          id: "apiIpRateLimitPerMinute",
          type: "number",
          labelKey: "staff.settings.board.apiIpRateLimit",
          helpKey: "staff.settings.board.apiIpRateLimitHelp",
          min: 1,
          max: 10_000,
        },
      ],
    },
    {
      id: "seo",
      titleKey: "staff.settings.board.section.seo",
      descriptionKey: "staff.settings.board.section.seoHelp",
      fields: [
        {
          id: "robotsTxt",
          type: "text",
          labelKey: "staff.settings.board.robotsTxt",
          helpKey: "staff.settings.board.robotsTxtHelp",
          multiline: true,
          maxLength: 65_535,
        },
      ],
    },
    {
      id: "offline",
      titleKey: "staff.settings.board.section.offline",
      descriptionKey: "staff.settings.board.section.offlineDescription",
      fields: [
        {
          id: "offline",
          type: "toggle",
          labelKey: "staff.settings.board.offline",
          helpKey: "staff.settings.board.offlineHelp",
        },
        {
          id: "offlineMessage",
          type: "text",
          labelKey: "staff.settings.board.offlineMessage",
          helpKey: "staff.settings.board.offlineMessageHelp",
          multiline: true,
          required: true,
          maxLength: 5_000,
          visibleWhen: { field: "offline", equals: true },
        },
      ],
    },
  ],
};

function toValues(settings: BoardSettings): FormValues {
  return {
    boardName: settings.boardName,
    boardDescription: settings.boardDescription,
    defaultLocale: settings.defaultLocale,
    offline: settings.offline,
    offlineMessage: settings.offlineMessage,
    newMemberApprovalPosts: settings.newMemberApprovalPosts,
    attachmentAllowedTypes: settings.attachmentAllowedTypes,
    reactionsAffectReputation: settings.reactionsAffectReputation,
    reputationDisplay: settings.reputationDisplay,
    apiKeyRateLimitPerMinute: settings.apiKeyRateLimitPerMinute,
    apiIpRateLimitPerMinute: settings.apiIpRateLimitPerMinute,
    robotsTxt: settings.robotsTxt,
    ...Object.fromEntries(
      REPUTATION_LABEL_FIELDS.map((field) => [
        field.id,
        settings.reputationLabelScale.find(
          (label) => label.labelKey === `reputation.label.${field.key}`,
        )?.min ?? field.fallback,
      ]),
    ),
  };
}

function toPayload(values: FormValues): BoardSettings {
  const rawLocale = typeof values.defaultLocale === "string" ? values.defaultLocale : null;

  return {
    boardName: typeof values.boardName === "string" ? values.boardName : "",
    boardDescription: typeof values.boardDescription === "string" ? values.boardDescription : "",
    defaultLocale: isLocale(rawLocale) ? rawLocale : "en",
    offline: values.offline === true,
    offlineMessage: typeof values.offlineMessage === "string" ? values.offlineMessage : "",
    newMemberApprovalPosts:
      typeof values.newMemberApprovalPosts === "number"
        ? values.newMemberApprovalPosts
        : Number(values.newMemberApprovalPosts ?? 0),
    attachmentAllowedTypes: Array.isArray(values.attachmentAllowedTypes)
      ? values.attachmentAllowedTypes
      : [],
    reactionsAffectReputation: values.reactionsAffectReputation === true,
    reputationDisplay: values.reputationDisplay !== false,
    apiKeyRateLimitPerMinute:
      typeof values.apiKeyRateLimitPerMinute === "number"
        ? values.apiKeyRateLimitPerMinute
        : Number(values.apiKeyRateLimitPerMinute ?? 60),
    apiIpRateLimitPerMinute:
      typeof values.apiIpRateLimitPerMinute === "number"
        ? values.apiIpRateLimitPerMinute
        : Number(values.apiIpRateLimitPerMinute ?? 120),
    robotsTxt: typeof values.robotsTxt === "string" ? values.robotsTxt : "",
    reputationLabelScale: REPUTATION_LABEL_FIELDS.map((field) => {
      const raw = values[field.id];
      return {
        min: typeof raw === "number" ? raw : Number(raw ?? field.fallback),
        labelKey: `reputation.label.${field.key}`,
      };
    }),
  };
}

export function BoardSettingsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<FormValues>(EMPTY_VALUES);
  const query = useQuery({
    queryKey: ["staff", "settings", "board"],
    queryFn: () => apiGet<BoardSettings>("/api/staff/settings/board"),
  });
  const mutation = useMutation({
    mutationFn: (payload: BoardSettings) =>
      apiPost<BoardSettings>("/api/staff/settings/board", payload),
    onSuccess: (data) => {
      setValues(toValues(data));
      queryClient.setQueryData(["staff", "settings", "board"], data);
      toast.pushToast({ messageKey: "staff.settings.board.saved", tone: "success" });
    },
    onError: () => {
      toast.pushToast({ messageKey: "staff.settings.board.error", tone: "error" });
    },
  });

  useEffect(() => {
    if (query.data !== undefined) {
      setValues(toValues(query.data));
    }
  }, [query.data]);

  return (
    <div className="page" data-page="board-settings">
      <header className="page-header">
        <h1>{t("staff.settings.board.title")}</h1>
        <p>{t("staff.settings.board.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.settings.board.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}
      {query.isSuccess ? (
        <FormRenderer
          definition={BOARD_FORM}
          values={values}
          onChange={setValues}
          onSubmit={(next) => mutation.mutate(toPayload(next))}
          submitting={mutation.isPending}
        />
      ) : null}
    </div>
  );
}
