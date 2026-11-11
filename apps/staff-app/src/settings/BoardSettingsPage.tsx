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
  readonly attachmentAllowedTypes: readonly string[];
}

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
  attachmentAllowedTypes: ATTACHMENT_TYPE_OPTIONS.map((option) => option.value),
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
    attachmentAllowedTypes: settings.attachmentAllowedTypes,
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
    attachmentAllowedTypes: Array.isArray(values.attachmentAllowedTypes)
      ? values.attachmentAllowedTypes
      : [],
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
