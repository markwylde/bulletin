import { useEffect, useRef, useState } from "react";
import { FlagsProvider, useFlag } from "../flags.tsx";
import {
  claimReauthDrafts,
  clearDraft,
  clearReauthDraft,
  draftWriteFor,
  type EditorDraft,
  readDraft,
  readEditorSession,
  readReauthDraft,
  serializeDraftWrite,
  writeDraft,
  writeReauthDraft,
} from "./editor/drafts.ts";
import type { EditorCommand, EditorController, EditorMode, EditorProps } from "./editor/types.ts";
import { uploadErrorMessage } from "./editor/upload-errors.ts";

interface SuggestedMember {
  readonly id: string;
  readonly displayName: string;
  readonly url: string;
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";
type UploadState = "uploading" | "processing" | "ready" | "failed";

interface PendingUpload {
  readonly key: string;
  readonly name: string;
  readonly state: UploadState;
  readonly progress: number;
  readonly message: string;
}

const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml,application/pdf,application/zip,text/plain,text/html,text/csv";
const INLINE_IMAGE = /^image\/(?:png|jpeg|gif|webp|avif)$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Uploads one file with progress; XHR is the only browser API with upload events. */
function putFile(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(`upload ${request.status}`));
      }
    };
    request.onerror = () => reject(new Error("upload network error"));
    request.send(file);
  });
}

const MENTION_AT_CURSOR = /(?:^|\s)@([\p{L}\p{N}_.-]{2,32})$/u;

function mentionQueryInSource(value: string, cursor: number): string | null {
  return MENTION_AT_CURSOR.exec(value.slice(0, Math.max(cursor, 0)))?.[1] ?? null;
}

function mentionQueryAtCursor(element: HTMLElement): string | null {
  const selection = window.getSelection();

  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }

  const node = selection.anchorNode;

  if (node === null || !element.contains(node)) {
    return null;
  }

  const text = (node.textContent ?? "").slice(0, selection.anchorOffset);
  return MENTION_AT_CURSOR.exec(text)?.[1] ?? null;
}

function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
): string {
  return `${value.slice(0, start)}${before}${value.slice(start, end)}${after}${value.slice(end)}`;
}

/** The editor island (ADR 0007): WYSIWYG/source, toolbar, emoticons, mentions and drafts. */
export function Editor(props: EditorProps) {
  return (
    <FlagsProvider value={{ mentions: props.flags.mentions, attachments: props.flags.attachments }}>
      <EditorContent {...props} />
    </FlagsProvider>
  );
}

function EditorContent({
  contextKey,
  name,
  initialMarkdown,
  forumId,
  conversationId,
  canUpload,
  emoticons,
  labels,
}: EditorProps) {
  const mentionsEnabled = useFlag("mentions");
  const attachmentsEnabled = useFlag("attachments");
  const canAttach = canUpload && attachmentsEnabled;
  const [mode, setMode] = useState<EditorMode>("source");
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [emoticonOpen, setEmoticonOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentions, setMentions] = useState<readonly SuggestedMember[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [uploads, setUploads] = useState<readonly PendingUpload[]>([]);
  const [dragging, setDragging] = useState(false);
  const initialRef = useRef(initialMarkdown);
  const baseSource = useRef(initialMarkdown);
  const markdownRef = useRef(initialMarkdown);
  const dirtyRef = useRef(false);
  const restoringRef = useRef(false);
  const editorElement = useRef<HTMLDivElement>(null);
  const sourceElement = useRef<HTMLTextAreaElement>(null);
  const fileElement = useRef<HTMLInputElement>(null);
  const controller = useRef<EditorController | null>(null);

  const markDirty = (): void => {
    dirtyRef.current = true;
    setDirty(true);
  };

  const updateMarkdown = (value: string): void => {
    markdownRef.current = value;
    setMarkdown(value);
    markDirty();
  };

  const syncFromEditor = (): void => {
    const current = controller.current?.getMarkdown();

    if (current !== undefined) {
      markdownRef.current = current;
      setMarkdown(current);
      markDirty();
    }
  };

  // Members get their own draft; guests keep typing without server-side personal data.
  useEffect(() => {
    let active = true;

    void readEditorSession().then((session) => {
      if (
        !active ||
        session?.authenticated !== true ||
        typeof session.csrfToken !== "string" ||
        typeof session.memberId !== "string"
      ) {
        return;
      }

      // A different account on this browser must never see a previous member's local draft.
      claimReauthDrafts(session.memberId);
      setMemberId(session.memberId);
      setCsrfToken(session.csrfToken);
      void readDraft(contextKey).then((value) => {
        if (active && value !== null && value.bodyMd !== initialRef.current) {
          setDraft(value);
        }
      });
    });

    return () => {
      active = false;
    };
  }, [contextKey]);

  // The stream asks editors to persist before the session's re-auth grace expires; server
  // draft autosave is refused at that point, so keep the text locally for the return.
  useEffect(() => {
    if (memberId === null) {
      return;
    }

    const persist = (): void => {
      if (markdownRef.current.trim() === "" || markdownRef.current === initialRef.current) {
        return;
      }

      writeReauthDraft(memberId, contextKey, markdownRef.current);
    };

    window.addEventListener("bulletin:reauth", persist);
    return () => {
      window.removeEventListener("bulletin:reauth", persist);
    };
  }, [contextKey, memberId]);

  // Offer a locally saved re-auth draft once the editor mounts again, for this member only.
  useEffect(() => {
    if (memberId === null) {
      return;
    }

    const saved = readReauthDraft(memberId, contextKey);

    if (saved !== null && saved !== initialRef.current) {
      setDraft({ contextKey, bodyMd: saved, updatedAt: new Date().toISOString() });
    }
  }, [contextKey, memberId]);

  // The personal overlay delivers the draft before/alongside the editor's own request.
  useEffect(() => {
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<EditorDraft>).detail;

      if (detail?.contextKey === contextKey && detail.bodyMd !== initialRef.current) {
        setDraft(detail);
      }
    };

    window.addEventListener("bulletin:draft", receive);
    return () => {
      window.removeEventListener("bulletin:draft", receive);
    };
  }, [contextKey]);

  // Start in WYSIWYG when JavaScript works; the server-rendered source mode is the fallback.
  useEffect(() => {
    setMode("wysiwyg");
    setReady(true);
  }, []);
  // Multi-quote inserts its directives into whichever mode is active (task 3.2).
  useEffect(() => {
    const insert = (event: Event): void => {
      const text = (event as CustomEvent<{ readonly text?: unknown }>).detail?.text;

      if (typeof text !== "string" || text === "") {
        return;
      }

      if (mode === "wysiwyg" && controller.current !== null) {
        controller.current.insertMarkdown(text);
        const current = controller.current.getMarkdown();

        if (current !== undefined) {
          markdownRef.current = current;
          setMarkdown(current);
          dirtyRef.current = true;
          setDirty(true);
        }

        return;
      }

      const next = `${markdownRef.current}${text}`;
      markdownRef.current = next;
      setMarkdown(next);
      dirtyRef.current = true;
      setDirty(true);
    };

    window.addEventListener("bulletin:insert-markdown", insert);
    return () => {
      window.removeEventListener("bulletin:insert-markdown", insert);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== "wysiwyg") {
      return;
    }

    const element = editorElement.current;

    if (element === null) {
      return;
    }

    let cancelled = false;
    let created: EditorController | null = null;

    void import("./editor/milkdown.ts").then(async ({ createMilkdownEditor }) => {
      const value = await createMilkdownEditor({
        element,
        markdown: markdownRef.current,
        label: labels.editor,
        emoticons,
        onChange: (next) => {
          markdownRef.current = next;
          setMarkdown(next);

          if (!restoringRef.current) {
            dirtyRef.current = true;
            setDirty(true);
          }

          setMentionQuery(mentionQueryAtCursor(element));
        },
      });

      if (cancelled) {
        value.destroy();
        return;
      }

      created = value;
      controller.current = value;
    });

    return () => {
      cancelled = true;
      created?.destroy();
      controller.current = null;
    };
  }, [mode, labels.editor, emoticons]);

  // 2 s debounce as specified by ADR 0007; the API stores one row per member and context.
  useEffect(() => {
    if (csrfToken === null) {
      return;
    }

    const mode = draftWriteFor(initialRef.current, markdown, dirty);

    if (mode === "none") {
      return;
    }

    const timer = setTimeout(() => {
      setStatus("saving");

      const write =
        mode === "clear"
          ? serializeDraftWrite(contextKey, async () =>
              (await clearDraft(contextKey, csrfToken)) ? "saved" : "failed",
            )
          : serializeDraftWrite(contextKey, async () =>
              (await writeDraft(contextKey, markdown, csrfToken)) !== null ? "saved" : "failed",
            );

      void write
        .then((nextStatus) => {
          setStatus(nextStatus);
        })
        .catch(() => {
          setStatus("failed");
        });
    }, 2_000);

    return () => {
      clearTimeout(timer);
    };
  }, [csrfToken, contextKey, dirty, markdown]);

  useEffect(() => {
    if (mentionQuery === null || !mentionsEnabled) {
      setMentions([]);
      setMentionOpen(false);
      return;
    }

    setMentionLoading(true);
    const timer = setTimeout(() => {
      void fetch(`/api/members/suggest?q=${encodeURIComponent(mentionQuery)}`, {
        headers: { accept: "application/json" },
      })
        .then(async (response) => {
          const body = response.ok
            ? ((await response.json()) as { members?: SuggestedMember[] })
            : { members: [] };
          setMentions(body.members ?? []);
          setMentionOpen(true);
        })
        .catch(() => {
          setMentions([]);
          setMentionOpen(false);
        })
        .finally(() => {
          setMentionLoading(false);
        });
    }, 200);

    return () => {
      clearTimeout(timer);
    };
  }, [mentionQuery, mentionsEnabled]);

  function switchMode(next: EditorMode): void {
    if (next === mode) {
      return;
    }

    if (next === "source") {
      // An untouched document keeps its exact source, including syntax WYSIWYG normalises.
      const current = dirtyRef.current
        ? (controller.current?.getMarkdown() ?? markdownRef.current)
        : baseSource.current;
      markdownRef.current = current;
      setMarkdown(current);
    }

    setMentionOpen(false);
    setEmoticonOpen(false);
    setMode(next);
  }

  function insertSourceText(text: string): void {
    const element = sourceElement.current;

    if (element === null) {
      updateMarkdown(`${markdownRef.current}${text}`);
      return;
    }

    const start = element.selectionStart;
    const end = element.selectionEnd;
    const next = `${markdownRef.current.slice(0, start)}${text}${markdownRef.current.slice(end)}`;
    updateMarkdown(next);

    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function sourceFormat(command: EditorCommand): void {
    const element = sourceElement.current;

    if (element === null) {
      return;
    }

    const start = element.selectionStart;
    const end = element.selectionEnd;

    const wraps: Record<EditorCommand, readonly [string, string]> = {
      bold: ["**", "**"],
      italic: ["*", "*"],
      heading: ["## ", ""],
      code: ["`", "`"],
      quote: ["> ", ""],
      list: ["- ", ""],
    };
    const [before, after] = wraps[command];
    const next =
      command === "heading" || command === "quote" || command === "list"
        ? `${markdownRef.current.slice(0, start)}${before}${markdownRef.current.slice(start)}`
        : wrapSelection(markdownRef.current, start, end, before, after);

    updateMarkdown(next);
    requestAnimationFrame(() => {
      element.focus();
      const cursor =
        command === "heading" || command === "quote" || command === "list"
          ? start + before.length
          : end + before.length + after.length;
      element.setSelectionRange(cursor, cursor);
    });
  }

  function runCommand(command: EditorCommand): void {
    if (mode === "wysiwyg") {
      controller.current?.format(command);
      syncFromEditor();
      return;
    }

    sourceFormat(command);
  }

  function insertMarkup(markdownValue: string): void {
    if (mode === "wysiwyg") {
      controller.current?.insertMarkdown(markdownValue);
      syncFromEditor();
      return;
    }

    insertSourceText(markdownValue);
  }

  function insertPlainText(text: string): void {
    if (mode === "wysiwyg") {
      controller.current?.insertText(text);
      syncFromEditor();
      return;
    }

    insertSourceText(text);
  }

  function restoreDraft(): void {
    if (draft === null) {
      return;
    }

    markdownRef.current = draft.bodyMd;
    baseSource.current = draft.bodyMd;
    dirtyRef.current = false;
    restoringRef.current = true;
    setMarkdown(draft.bodyMd);
    setDirty(false);
    controller.current?.replaceAll(draft.bodyMd);
    window.setTimeout(() => {
      restoringRef.current = false;
    }, 400);
    setDraft(null);

    if (memberId !== null) {
      clearReauthDraft(memberId, contextKey);
    }
  }

  function discardDraft(): void {
    setDraft(null);

    if (memberId !== null) {
      clearReauthDraft(memberId, contextKey);
    }

    if (csrfToken !== null) {
      void clearDraft(contextKey, csrfToken);
    }
  }

  function replaceSourceMention(member: SuggestedMember): void {
    if (mentionQuery === null) {
      return;
    }

    const element = sourceElement.current;
    const value = markdownRef.current;
    const end = element?.selectionEnd ?? value.length;
    const cursor = element?.selectionStart ?? end;
    const start = Math.max(0, cursor - mentionQuery.length - 1);
    const token = `@[${member.displayName}](member:${member.id}) `;

    updateMarkdown(`${value.slice(0, start)}${token}${value.slice(end)}`);
    const caret = start + token.length;

    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(caret, caret);
    });
  }

  function chooseMention(member: SuggestedMember): void {
    if (mentionQuery !== null) {
      if (mode === "wysiwyg") {
        controller.current?.replaceTextBeforeCursor(mentionQuery.length + 1, "");
        controller.current?.insertMemberMention(member.id, member.displayName);
        controller.current?.insertText(" ");
        syncFromEditor();
      } else {
        replaceSourceMention(member);
      }
    }

    setMentionQuery(null);
    setMentionOpen(false);
  }

  function syncSourceMention(element: HTMLTextAreaElement): void {
    setMentionQuery(mentionQueryInSource(element.value, element.selectionStart));
  }

  function chooseEmoticon(code: string): void {
    const text = `:${code}: `;

    if (mode === "wysiwyg") {
      controller.current?.insertText(text);
      syncFromEditor();
    } else {
      insertSourceText(text);
    }

    setEmoticonOpen(false);
  }

  function updateUpload(key: string, patch: Partial<PendingUpload>): void {
    setUploads((current) =>
      current.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload)),
    );
  }

  function uploadErrorLabel(body: {
    readonly code?: string;
    readonly remainingBytes?: number;
  }): string {
    return uploadErrorMessage(
      labels,
      body,
      document.documentElement.lang === "" ? "en" : document.documentElement.lang,
    );
  }

  async function finaliseUpload(id: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(`/api/attachments/${id}/finalise`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bulletin-csrf": csrfToken ?? "",
        },
        body: "{}",
      });
      const body = (await response.json().catch(() => ({}))) as {
        readonly state?: string;
        readonly code?: string;
        readonly remainingBytes?: number;
      };

      if (!response.ok) {
        if (body.code === "attachment_rejected") {
          throw new Error(labels.uploadRejected);
        }

        throw new Error(uploadErrorLabel(body));
      }

      if (body.state === "ready") {
        return;
      }

      if (body.state === "rejected") {
        throw new Error(labels.uploadRejected);
      }

      await sleep(1_000);
    }

    throw new Error(labels.uploadFailed);
  }

  async function uploadFiles(files: readonly File[]): Promise<void> {
    if (
      !canAttach ||
      csrfToken === null ||
      (forumId === "" && (conversationId === undefined || conversationId === ""))
    ) {
      return;
    }

    for (const file of files) {
      const key = crypto.randomUUID();
      setUploads((current) => [
        ...current,
        { key, name: file.name, state: "uploading", progress: 0, message: "" },
      ]);

      try {
        const response = await fetch("/api/attachments", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bulletin-csrf": csrfToken,
          },
          body: JSON.stringify({
            ...(conversationId === undefined || conversationId === ""
              ? { forumId }
              : { conversationId }),
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            readonly code?: string;
            readonly remainingBytes?: number;
          };
          throw new Error(uploadErrorLabel(body));
        }

        const created = (await response.json()) as {
          readonly id: string;
          readonly upload: { readonly url: string };
        };

        await putFile(created.upload.url, file, (progress) => {
          updateUpload(key, { progress });
        });
        updateUpload(key, { state: "processing", progress: 100 });
        await finaliseUpload(created.id);

        const name = file.name.replace(/[[\]()]/g, "_").slice(0, 120) || "file";
        insertMarkup(
          INLINE_IMAGE.test(file.type)
            ? `![${name}](attachment:${created.id})`
            : `[${name}](attachment:${created.id})`,
        );
        updateUpload(key, { state: "ready", message: labels.uploadReady });
        window.setTimeout(() => {
          setUploads((current) => current.filter((upload) => upload.key !== key));
        }, 3_000);
      } catch (error) {
        updateUpload(key, {
          state: "failed",
          message: error instanceof Error ? error.message : labels.uploadFailed,
        });
      }
    }
  }

  function uploadStatusLabel(upload: PendingUpload): string {
    switch (upload.state) {
      case "uploading":
        return `${labels.uploading} ${upload.progress}%`;
      case "processing":
        return labels.processing;
      case "ready":
        return labels.uploadReady;
      case "failed":
        return upload.message;
    }
  }

  const statusText =
    status === "saving"
      ? labels.saving
      : status === "saved"
        ? labels.saved
        : status === "failed"
          ? labels.saveFailed
          : "";

  return (
    <fieldset
      className={`bl-editor${dragging ? " is-dragging" : ""}`}
      data-editor
      data-draft-context={contextKey}
      data-editor-can-upload={canAttach ? "true" : "false"}
      {...(ready ? { "data-editor-ready": "true" } : {})}
      onDragOver={(event) => {
        if (!canAttach) {
          return;
        }

        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!canAttach) {
          return;
        }

        event.preventDefault();
        setDragging(false);
        void uploadFiles([...event.dataTransfer.files]);
      }}
      onPaste={(event) => {
        if (!canAttach) {
          return;
        }

        const files = [...(event.clipboardData?.files ?? [])];

        if (files.length > 0) {
          event.preventDefault();
          void uploadFiles(files);
        }
      }}
    >
      {name === undefined ? null : <input type="hidden" name={name} value={markdown} />}
      <fieldset className="bl-editor__modes" aria-label={labels.editor}>
        <button
          className="bl-button bl-button--quiet bl-button--small"
          type="button"
          aria-pressed={mode === "wysiwyg"}
          data-editor-mode="wysiwyg"
          onClick={() => switchMode("wysiwyg")}
        >
          {labels.wysiwyg}
        </button>
        <button
          className="bl-button bl-button--quiet bl-button--small"
          type="button"
          aria-pressed={mode === "source"}
          data-editor-mode="source"
          onClick={() => switchMode("source")}
        >
          {labels.source}
        </button>
        <span className="bl-visually-hidden" aria-live="polite" data-editor-mode-announcement>
          {mode === "wysiwyg" ? labels.wysiwyg : labels.source}
        </span>
      </fieldset>

      {draft === null ? null : (
        <div className="bl-editor__draft" data-draft-offer role="status">
          <span>{labels.draftFound}</span>
          <button
            className="bl-button bl-button--small"
            type="button"
            data-draft-restore
            onClick={restoreDraft}
          >
            {labels.restoreDraft}
          </button>
          <button
            className="bl-button bl-button--quiet bl-button--small"
            type="button"
            data-draft-discard
            onClick={discardDraft}
          >
            {labels.discardDraft}
          </button>
        </div>
      )}

      <div
        className="bl-editor__toolbar"
        role="toolbar"
        aria-label={labels.toolbar}
        data-editor-toolbar
      >
        <button
          type="button"
          aria-label={labels.bold}
          data-editor-command="bold"
          onClick={() => runCommand("bold")}
        >
          B
        </button>
        <button
          type="button"
          aria-label={labels.italic}
          data-editor-command="italic"
          onClick={() => runCommand("italic")}
        >
          I
        </button>
        <button
          type="button"
          aria-label={labels.heading}
          data-editor-command="heading"
          onClick={() => runCommand("heading")}
        >
          H
        </button>
        <button
          type="button"
          aria-label={labels.link}
          data-editor-command="link"
          onClick={() => insertMarkup("[link](https://)")}
        >
          ↗
        </button>
        <button
          type="button"
          aria-label={labels.code}
          data-editor-command="code"
          onClick={() => runCommand("code")}
        >
          {"</>"}
        </button>
        <button
          type="button"
          aria-label={labels.quote}
          data-editor-command="quote"
          onClick={() => runCommand("quote")}
        >
          ❝
        </button>
        <button
          type="button"
          aria-label={labels.spoiler}
          data-editor-command="spoiler"
          onClick={() => insertMarkup("||spoiler||")}
        >
          ◌
        </button>
        <button
          type="button"
          aria-label={labels.list}
          data-editor-command="list"
          onClick={() => runCommand("list")}
        >
          ≡
        </button>
        <button
          type="button"
          aria-label={labels.emoticon}
          data-editor-emoticon
          aria-expanded={emoticonOpen}
          onClick={() => setEmoticonOpen((open) => !open)}
        >
          ☺
        </button>
        {mentionsEnabled ? (
          <button
            type="button"
            aria-label={labels.mention}
            data-editor-mention
            onClick={() => insertPlainText("@")}
          >
            @
          </button>
        ) : null}
        {canAttach ? (
          <>
            <button
              type="button"
              aria-label={labels.attach}
              data-editor-attach
              disabled={csrfToken === null}
              onClick={() => fileElement.current?.click()}
            >
              📎
            </button>
            <input
              ref={fileElement}
              type="file"
              multiple
              hidden
              accept={ATTACHMENT_ACCEPT}
              data-editor-file-input
              onChange={(event) => {
                const files = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                void uploadFiles(files);
              }}
            />
          </>
        ) : null}
      </div>

      {canAttach ? (
        <div className="bl-editor__attachments" data-editor-attachments>
          <p className="bl-muted" data-editor-attach-hint>
            {labels.attachHint}
          </p>
          {uploads.map((upload) => (
            <p
              key={upload.key}
              className={upload.state === "failed" ? "bl-error-text" : "bl-muted"}
              data-upload-status={upload.state}
              data-upload-name={upload.name}
            >
              <span>{upload.name}</span> <span>{uploadStatusLabel(upload)}</span>
            </p>
          ))}
        </div>
      ) : null}

      {emoticonOpen ? (
        <div
          className="bl-editor__popover"
          data-emoticon-picker
          role="menu"
          aria-label={labels.emoticon}
        >
          {emoticons.map((emoticon) => (
            <button
              key={emoticon.code}
              type="button"
              role="menuitem"
              data-emoticon-code={emoticon.code}
              aria-label={emoticon.alt}
              onClick={() => chooseEmoticon(emoticon.code)}
            >
              <img src={emoticon.src} alt="" width={20} height={20} />
              <span>:{emoticon.code}:</span>
            </button>
          ))}
        </div>
      ) : null}

      {mentionsEnabled && mentionOpen ? (
        <div
          className="bl-editor__mentions"
          data-mention-list
          role="listbox"
          aria-label={labels.mention}
        >
          {mentionLoading ? <p className="bl-muted">{labels.mentionLoading}</p> : null}
          {!mentionLoading && mentions.length === 0 ? (
            <p className="bl-muted">{labels.mentionEmpty}</p>
          ) : null}
          {mentions.map((member) => (
            <button
              key={member.id}
              type="button"
              role="option"
              aria-selected={false}
              data-mention-id={member.id}
              onClick={() => chooseMention(member)}
            >
              {member.displayName}
            </button>
          ))}
        </div>
      ) : null}

      {mode === "wysiwyg" ? (
        <div ref={editorElement} className="bl-editor__surface" data-editor-wysiwyg />
      ) : (
        <textarea
          ref={sourceElement}
          className="bl-editor__source"
          data-editor-source
          aria-label={labels.editor}
          value={markdown}
          onChange={(event) => {
            updateMarkdown(event.currentTarget.value);
            syncSourceMention(event.currentTarget);
          }}
          onSelect={(event) => syncSourceMention(event.currentTarget)}
        />
      )}

      <p
        className="bl-editor__status"
        role="status"
        data-editor-status={status}
        data-draft-status={status}
      >
        {statusText}
      </p>
    </fieldset>
  );
}
