import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";

interface EmoticonView {
  readonly id: string;
  readonly code: string;
  readonly alt: string;
  readonly position: number;
  readonly src: string;
}

interface EmoticonSetView {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly position: number;
  readonly editorVisible: boolean;
  readonly emoticons: readonly EmoticonView[];
}

interface EmoticonsView {
  readonly sets: readonly EmoticonSetView[];
}

interface SetDraft {
  readonly key: string;
  readonly title: string;
  readonly position: number;
  readonly editorVisible: boolean;
}

interface EmoticonDraft {
  readonly code: string;
  readonly alt: string;
  readonly position: number;
  readonly imageBase64: string;
  readonly contentType: string;
}

const EMPTY_SET: SetDraft = { key: "", title: "", position: 0, editorVisible: true };
const EMPTY_EMOTICON: EmoticonDraft = {
  code: "",
  alt: "",
  position: 0,
  imageBase64: "",
  contentType: "",
};

async function fileBase64(file: File): Promise<{ imageBase64: string; contentType: string }> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const comma = data.indexOf(",");

  return {
    imageBase64: comma < 0 ? "" : data.slice(comma + 1),
    contentType: file.type,
  };
}

export function EmoticonsPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [setDraft, setSetDraft] = useState<SetDraft>(EMPTY_SET);
  const [emoticonSetId, setEmoticonSetId] = useState<string | null>(null);
  const [emoticonDraft, setEmoticonDraft] = useState<EmoticonDraft>(EMPTY_EMOTICON);
  const query = useQuery({
    queryKey: ["staff", "emoticons"],
    queryFn: () => apiGet<EmoticonsView>("/api/staff/emoticons"),
  });
  const mutate = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiPost("/api/staff/emoticons", body),
    onSuccess: () => {
      toast.pushToast({ messageKey: "staff.emoticons.saved", tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["staff", "emoticons"] });
    },
    onError: (error: unknown) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (code === "duplicate_code") {
        toast.pushToast({ messageKey: "staff.emoticons.duplicateCode", tone: "error" });
      } else if (code === "duplicate_key") {
        toast.pushToast({ messageKey: "staff.emoticons.duplicateSet", tone: "error" });
      } else {
        toast.pushToast({ messageKey: "staff.emoticons.saveError", tone: "error" });
      }
    },
  });

  const saveSet = (): void => {
    if (setDraft.key.trim() === "" || setDraft.title.trim() === "") {
      toast.pushToast({ messageKey: "staff.emoticons.invalid", tone: "error" });
      return;
    }

    mutate.mutate(
      { action: "set-save", set: setDraft },
      { onSuccess: () => setSetDraft(EMPTY_SET) },
    );
  };

  const chooseFile = async (file: File | null): Promise<void> => {
    if (file === null) {
      return;
    }

    try {
      const image = await fileBase64(file);
      setEmoticonDraft((current) => ({ ...current, ...image }));
    } catch {
      toast.pushToast({ messageKey: "staff.emoticons.invalidImage", tone: "error" });
    }
  };

  const saveEmoticon = (): void => {
    if (emoticonSetId === null) {
      return;
    }

    if (
      emoticonDraft.code.trim() === "" ||
      emoticonDraft.alt.trim() === "" ||
      emoticonDraft.imageBase64 === ""
    ) {
      toast.pushToast({ messageKey: "staff.emoticons.invalid", tone: "error" });
      return;
    }

    mutate.mutate(
      {
        action: "emoticon-save",
        setId: emoticonSetId,
        code: emoticonDraft.code,
        alt: emoticonDraft.alt,
        position: emoticonDraft.position,
        imageBase64: emoticonDraft.imageBase64,
        contentType: emoticonDraft.contentType,
      },
      { onSuccess: () => setEmoticonDraft(EMPTY_EMOTICON) },
    );
  };

  return (
    <div className="page" data-page="emoticons">
      <header className="page-header">
        <h1>{t("staff.emoticons.title")}</h1>
        <p>{t("staff.emoticons.intro")}</p>
      </header>

      {query.isPending ? <p className="widget-muted">{t("staff.widget.loading")}</p> : null}
      {query.isError ? (
        <div className="widget-error" role="alert">
          <p>{t("staff.emoticons.loadError")}</p>
          <button type="button" onClick={() => void query.refetch()}>
            {t("staff.widget.retry")}
          </button>
        </div>
      ) : null}

      {query.isSuccess ? (
        <>
          <section className="admin-panel" aria-labelledby="emoticon-sets-title">
            <h2 id="emoticon-sets-title">{t("staff.emoticons.sets")}</h2>
            <ul className="emoticon-set-list" data-emoticon-set-list>
              {query.data.sets.map((set) => (
                <li className="emoticon-set" key={set.id} data-emoticon-set={set.id}>
                  <header className="emoticon-set__header">
                    <strong>{set.title}</strong>
                    <span className="widget-muted">
                      {t("staff.emoticons.setMeta", {
                        key: set.key,
                        count: set.emoticons.length,
                      })}
                      {set.editorVisible ? "" : ` · ${t("staff.emoticons.hidden")}`}
                    </span>
                    <button
                      type="button"
                      data-emoticon-add={set.id}
                      onClick={() => setEmoticonSetId(set.id)}
                    >
                      {t("staff.emoticons.addEmoticon")}
                    </button>
                    <button
                      type="button"
                      data-emoticon-set-delete={set.id}
                      onClick={() => mutate.mutate({ action: "set-delete", id: set.id })}
                    >
                      {t("staff.emoticons.deleteSet")}
                    </button>
                  </header>
                  <ul className="emoticon-list" data-emoticon-list>
                    {set.emoticons.map((emoticon) => (
                      <li className="emoticon-row" key={emoticon.id} data-emoticon={emoticon.id}>
                        <img src={emoticon.src} alt={emoticon.alt} width={24} height={24} />
                        <code>:{emoticon.code}:</code>
                        <span>{emoticon.alt}</span>
                        <span className="widget-muted">{emoticon.position}</span>
                        <button
                          type="button"
                          data-emoticon-delete={emoticon.id}
                          onClick={() =>
                            mutate.mutate({ action: "emoticon-delete", id: emoticon.id })
                          }
                        >
                          {t("staff.emoticons.delete")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {query.data.sets.length === 0 ? (
              <p className="widget-muted">{t("staff.emoticons.empty")}</p>
            ) : null}
          </section>

          <section className="admin-panel" aria-labelledby="emoticon-set-editor-title">
            <h2 id="emoticon-set-editor-title">{t("staff.emoticons.setForm")}</h2>
            <div className="admin-form" data-emoticon-set-form>
              <label>
                <span>{t("staff.emoticons.field.key")}</span>
                <input
                  data-emoticon-set-field="key"
                  value={setDraft.key}
                  onChange={(event) => setSetDraft((c) => ({ ...c, key: event.target.value }))}
                />
              </label>
              <label>
                <span>{t("staff.emoticons.field.title")}</span>
                <input
                  data-emoticon-set-field="title"
                  value={setDraft.title}
                  onChange={(event) => setSetDraft((c) => ({ ...c, title: event.target.value }))}
                />
              </label>
              <label>
                <span>{t("staff.emoticons.field.position")}</span>
                <input
                  type="number"
                  min={0}
                  data-emoticon-set-field="position"
                  value={setDraft.position}
                  onChange={(event) =>
                    setSetDraft((c) => ({ ...c, position: Number(event.target.value) || 0 }))
                  }
                />
              </label>
              <label className="admin-check">
                <input
                  type="checkbox"
                  data-emoticon-set-field="visible"
                  checked={setDraft.editorVisible}
                  onChange={(event) =>
                    setSetDraft((c) => ({ ...c, editorVisible: event.target.checked }))
                  }
                />
                <span>{t("staff.emoticons.field.visible")}</span>
              </label>
              <button type="button" data-emoticon-set-save onClick={saveSet}>
                {t("staff.emoticons.saveSet")}
              </button>
            </div>
          </section>

          {emoticonSetId === null ? null : (
            <section className="admin-panel" aria-labelledby="emoticon-editor-title">
              <h2 id="emoticon-editor-title">{t("staff.emoticons.emoticonForm")}</h2>
              <div className="admin-form" data-emoticon-form>
                <label>
                  <span>{t("staff.emoticons.field.code")}</span>
                  <input
                    data-emoticon-field="code"
                    value={emoticonDraft.code}
                    onChange={(event) =>
                      setEmoticonDraft((c) => ({ ...c, code: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.emoticons.field.alt")}</span>
                  <input
                    data-emoticon-field="alt"
                    value={emoticonDraft.alt}
                    onChange={(event) =>
                      setEmoticonDraft((c) => ({ ...c, alt: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.emoticons.field.position")}</span>
                  <input
                    type="number"
                    min={0}
                    data-emoticon-field="position"
                    value={emoticonDraft.position}
                    onChange={(event) =>
                      setEmoticonDraft((c) => ({
                        ...c,
                        position: Number(event.target.value) || 0,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>{t("staff.emoticons.field.image")}</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    data-emoticon-field="image"
                    onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                <button type="button" data-emoticon-save onClick={saveEmoticon}>
                  {t("staff.emoticons.saveEmoticon")}
                </button>
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
