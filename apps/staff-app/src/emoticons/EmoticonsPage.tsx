import { useT } from "@bulletin/ui";
import { ConfirmDialog, useToast } from "@bulletin/ui/feedback";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiPost } from "../api.ts";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  FormActions,
  IconEdit,
  IconPlus,
  IconTrash,
  MenuItem,
  Page,
  Panel,
  QueryState,
  RowActions,
  Switch,
  TextInput,
} from "../ui/index.ts";

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
  const [editingEmoticonId, setEditingEmoticonId] = useState<string | null>(null);
  const [emoticonDraft, setEmoticonDraft] = useState<EmoticonDraft>(EMPTY_EMOTICON);
  const [confirm, setConfirm] = useState<{ kind: "set" | "emoticon"; id: string } | null>(null);
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
      (emoticonDraft.imageBase64 === "" && editingEmoticonId === null)
    ) {
      toast.pushToast({ messageKey: "staff.emoticons.invalid", tone: "error" });
      return;
    }

    mutate.mutate(
      {
        action: "emoticon-save",
        ...(editingEmoticonId === null ? {} : { id: editingEmoticonId }),
        setId: emoticonSetId,
        code: emoticonDraft.code,
        alt: emoticonDraft.alt,
        position: emoticonDraft.position,
        imageBase64: emoticonDraft.imageBase64,
        contentType: emoticonDraft.contentType,
      },
      {
        onSuccess: () => {
          setEmoticonDraft(EMPTY_EMOTICON);
          setEditingEmoticonId(null);
          setEmoticonSetId(null);
        },
      },
    );
  };

  const closeEmoticon = (): void => {
    setEmoticonSetId(null);
    setEditingEmoticonId(null);
    setEmoticonDraft(EMPTY_EMOTICON);
  };

  return (
    <Page
      id="emoticons"
      title={t("staff.emoticons.title")}
      description={t("staff.emoticons.intro")}
    >
      <QueryState query={query} errorLabel={t("staff.emoticons.loadError")}>
        {(data) => (
          <div className="page-split">
            <div className="stack" data-emoticon-set-list>
              {data.sets.length === 0 ? (
                <Panel>
                  <EmptyState title={t("staff.emoticons.empty")} />
                </Panel>
              ) : null}
              {data.sets.map((set) => (
                <Panel
                  key={set.id}
                  flush
                  data-emoticon-set={set.id}
                  title={
                    <span className="cluster">
                      {set.title}
                      {set.editorVisible ? null : <Badge>{t("staff.emoticons.hidden")}</Badge>}
                    </span>
                  }
                  description={t("staff.emoticons.setMeta", {
                    key: set.key,
                    count: set.emoticons.length,
                  })}
                  actions={
                    <span className="cluster cluster-end">
                      <Button
                        size="sm"
                        icon={<IconPlus size={14} />}
                        data-emoticon-add={set.id}
                        onClick={() => {
                          setEditingEmoticonId(null);
                          setEmoticonDraft(EMPTY_EMOTICON);
                          setEmoticonSetId(set.id);
                        }}
                      >
                        {t("staff.emoticons.addEmoticon")}
                      </Button>
                      <RowActions label={t("staff.rowActions")}>
                        <MenuItem
                          tone="danger"
                          icon={<IconTrash size={16} />}
                          data-emoticon-set-delete={set.id}
                          onClick={() => setConfirm({ kind: "set", id: set.id })}
                        >
                          {t("staff.emoticons.deleteSet")}
                        </MenuItem>
                      </RowActions>
                    </span>
                  }
                >
                  {set.emoticons.length === 0 ? (
                    <EmptyState title={t("staff.emoticons.setEmpty")} />
                  ) : (
                    <ul className="emoticon-grid" data-emoticon-list>
                      {set.emoticons.map((emoticon) => (
                        <li className="emoticon-tile" key={emoticon.id} data-emoticon={emoticon.id}>
                          <img src={emoticon.src} alt={emoticon.alt} width={28} height={28} />
                          <span className="emoticon-tile-text">
                            <code>:{emoticon.code}:</code>
                            <span className="subtle truncate">{emoticon.alt}</span>
                          </span>
                          <RowActions label={t("staff.rowActions")}>
                            <MenuItem
                              icon={<IconEdit size={16} />}
                              data-emoticon-edit={emoticon.id}
                              onClick={() => {
                                setEmoticonSetId(set.id);
                                setEditingEmoticonId(emoticon.id);
                                setEmoticonDraft({
                                  code: emoticon.code,
                                  alt: emoticon.alt,
                                  position: emoticon.position,
                                  imageBase64: "",
                                  contentType: "",
                                });
                              }}
                            >
                              {t("staff.emoticons.edit")}
                            </MenuItem>
                            <MenuItem
                              tone="danger"
                              icon={<IconTrash size={16} />}
                              data-emoticon-delete={emoticon.id}
                              onClick={() => setConfirm({ kind: "emoticon", id: emoticon.id })}
                            >
                              {t("staff.emoticons.delete")}
                            </MenuItem>
                          </RowActions>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              ))}
            </div>

            <Panel title={t("staff.emoticons.setForm")}>
              <div className="stack" data-emoticon-set-form>
                <div className="form-grid">
                  <Field label={t("staff.emoticons.field.key")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        data-emoticon-set-field="key"
                        value={setDraft.key}
                        onChange={(event) =>
                          setSetDraft((c) => ({ ...c, key: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                  <Field label={t("staff.emoticons.field.position")}>
                    {({ id }) => (
                      <TextInput
                        id={id}
                        type="number"
                        min={0}
                        data-emoticon-set-field="position"
                        value={setDraft.position}
                        onChange={(event) =>
                          setSetDraft((c) => ({ ...c, position: Number(event.target.value) || 0 }))
                        }
                      />
                    )}
                  </Field>
                </div>
                <Field label={t("staff.emoticons.field.title")}>
                  {({ id }) => (
                    <TextInput
                      id={id}
                      data-emoticon-set-field="title"
                      value={setDraft.title}
                      onChange={(event) =>
                        setSetDraft((c) => ({ ...c, title: event.target.value }))
                      }
                    />
                  )}
                </Field>
                <Switch
                  data-emoticon-set-field="visible"
                  label={t("staff.emoticons.field.visible")}
                  checked={setDraft.editorVisible}
                  onChange={(event) =>
                    setSetDraft((c) => ({ ...c, editorVisible: event.target.checked }))
                  }
                />
                <FormActions>
                  <Button variant="primary" data-emoticon-set-save onClick={saveSet}>
                    {t("staff.emoticons.saveSet")}
                  </Button>
                </FormActions>
              </div>
            </Panel>
          </div>
        )}
      </QueryState>

      <Dialog
        open={emoticonSetId !== null}
        title={t("staff.emoticons.emoticonForm")}
        closeLabel={t("staff.nav.close")}
        onClose={closeEmoticon}
        footer={
          <>
            <Button variant="ghost" onClick={closeEmoticon}>
              {t("staff.emoticons.cancel")}
            </Button>
            <Button variant="primary" data-emoticon-save onClick={saveEmoticon}>
              {t("staff.emoticons.saveEmoticon")}
            </Button>
          </>
        }
      >
        <div className="stack" data-emoticon-form>
          <div className="form-grid">
            <Field label={t("staff.emoticons.field.code")}>
              {({ id }) => (
                <TextInput
                  id={id}
                  data-emoticon-field="code"
                  value={emoticonDraft.code}
                  onChange={(event) =>
                    setEmoticonDraft((c) => ({ ...c, code: event.target.value }))
                  }
                />
              )}
            </Field>
            <Field label={t("staff.emoticons.field.position")}>
              {({ id }) => (
                <TextInput
                  id={id}
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
              )}
            </Field>
          </div>
          <Field label={t("staff.emoticons.field.alt")}>
            {({ id }) => (
              <TextInput
                id={id}
                data-emoticon-field="alt"
                value={emoticonDraft.alt}
                onChange={(event) => setEmoticonDraft((c) => ({ ...c, alt: event.target.value }))}
              />
            )}
          </Field>
          <Field label={t("staff.emoticons.field.image")}>
            {({ id }) => (
              <input
                id={id}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                data-emoticon-field="image"
                onChange={(event) => void chooseFile(event.target.files?.[0] ?? null)}
              />
            )}
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirm !== null}
        titleKey={
          confirm?.kind === "set"
            ? "staff.emoticons.confirmDeleteSet.title"
            : "staff.emoticons.confirmDelete.title"
        }
        bodyKey={
          confirm?.kind === "set"
            ? "staff.emoticons.confirmDeleteSet.body"
            : "staff.emoticons.confirmDelete.body"
        }
        confirmLabelKey={
          confirm?.kind === "set" ? "staff.emoticons.deleteSet" : "staff.emoticons.delete"
        }
        tone="danger"
        busy={mutate.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);

          if (target !== null) {
            mutate.mutate({
              action: target.kind === "set" ? "set-delete" : "emoticon-delete",
              id: target.id,
            });
          }
        }}
      />
    </Page>
  );
}
