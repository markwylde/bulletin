import type { Locale } from "@bulletin/i18n";
import { useT } from "@bulletin/ui";
import { useToast } from "@bulletin/ui/feedback";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, apiDelete, apiGet, apiPost } from "../api.ts";
import { diffLines } from "./diff.ts";

type ThemeSource = "core" | "marketplace" | "upload" | "custom";
type Tab = "templates" | "tokens" | "css" | "assets" | "strings";
type Scheme = "light" | "dark";

interface ThemeSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly parentName: string | null;
  readonly version: number;
  readonly source: ThemeSource;
  readonly description: string;
  readonly templateCount: number;
  readonly childCount: number;
}

interface TemplateView {
  readonly name: string;
  readonly body: string;
  readonly version: number;
  readonly inheritedFrom: string | null;
  readonly parentBody: string | null;
  readonly canRevert: boolean;
}

interface TemplateVersion {
  readonly name: string;
  readonly version: number;
  readonly body: string;
  readonly updatedBy: string | null;
  readonly createdAt: string;
}

interface AssetView {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
}

interface StringView {
  readonly locale: Locale;
  readonly key: string;
  readonly value: string;
}

interface ThemeDetail {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly parentName: string | null;
  readonly version: number;
  readonly source: ThemeSource;
  readonly description: string;
  readonly editable: boolean;
  readonly templates: readonly TemplateView[];
  readonly versions: readonly TemplateVersion[];
  readonly tokens: readonly { readonly scheme: Scheme; readonly tokens: Record<string, string> }[];
  readonly css: string;
  readonly assets: readonly AssetView[];
  readonly strings: readonly StringView[];
}

interface TemplateIssue {
  readonly code: string;
  readonly line: number;
  readonly column: number;
  readonly element: string;
  readonly attribute?: string;
  readonly detail?: string;
}

const TOKEN_KEYS = [
  "bg",
  "surface",
  "surface-muted",
  "text",
  "muted",
  "border",
  "accent",
  "accent-text",
  "accent-soft",
  "danger",
  "radius",
  "radius-small",
  "space",
  "space-small",
  "width",
  "touch",
  "font",
] as const;

function tokenState(theme: ThemeDetail): Record<Scheme, Record<string, string>> {
  const state: Record<Scheme, Record<string, string>> = { light: {}, dark: {} };

  for (const entry of theme.tokens) {
    state[entry.scheme] = { ...entry.tokens };
  }

  return state;
}

function stringState(theme: ThemeDetail): StringView[] {
  return theme.strings.length > 0 ? [...theme.strings] : [{ locale: "en", key: "", value: "" }];
}

function assetUrl(name: string): string {
  return `/theme-assets/${name}`;
}

function sourceLabel(t: (key: string) => string, source: ThemeSource): string {
  switch (source) {
    case "core":
      return t("staff.themes.source.core");
    case "custom":
      return t("staff.themes.source.custom");
    case "marketplace":
      return t("staff.themes.source.marketplace");
    case "upload":
      return t("staff.themes.source.upload");
  }
}

function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

function errorBody(error: unknown): Record<string, unknown> {
  if (!(error instanceof ApiError)) {
    return {};
  }

  return typeof error.body === "object" && error.body !== null
    ? (error.body as Record<string, unknown>)
    : {};
}

function bytesLabel(value: number): string {
  return value >= 1024 ? `${Math.round(value / 1024)} kB` : `${value} B`;
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function ThemesPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("templates");
  const [childName, setChildName] = useState("");
  const [childParent, setChildParent] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("header");
  const [templateBody, setTemplateBody] = useState("");
  const [version, setVersion] = useState<string>("");
  const [tokens, setTokens] = useState<Record<Scheme, Record<string, string>>>({
    light: {},
    dark: {},
  });
  const [css, setCss] = useState("");
  const [strings, setStrings] = useState<StringView[]>([]);
  const [assetName, setAssetName] = useState("");

  const list = useQuery({
    queryKey: ["staff", "themes"],
    queryFn: () => apiGet<{ themes: readonly ThemeSummary[] }>("/api/staff/themes"),
  });
  const detail = useQuery({
    queryKey: ["staff", "themes", selected],
    queryFn: () => apiGet<{ theme: ThemeDetail }>(`/api/staff/themes/detail?id=${selected ?? ""}`),
    enabled: selected !== null,
  });
  const theme = detail.data?.theme ?? null;

  useEffect(() => {
    if (theme === null) {
      return;
    }

    const first =
      theme.templates.find((entry) => entry.name === templateName) ?? theme.templates[0];
    const name = first?.name ?? "header";
    setTemplateName(name);
    setTemplateBody(theme.templates.find((entry) => entry.name === name)?.body ?? "");
    setTokens(tokenState(theme));
    setCss(theme.css);
    setStrings(stringState(theme));
    setPreviewUrl(null);
  }, [theme, templateName]);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["staff", "themes"] });
  };

  const describeError = (caught: unknown): string => {
    const code = errorCode(caught);

    if (code === "invalid_template") {
      return renderValidation(caught);
    }

    if (code === "css_syntax") {
      return t("staff.themes.css.syntax");
    }

    if (code === "css_import") {
      return t("staff.themes.css.import");
    }

    if (code === "css_external_url") {
      return t("staff.themes.css.external");
    }

    if (code === "css_expression") {
      return t("staff.themes.css.expression");
    }

    if (code === "css_too_large") {
      return t("staff.themes.css.tooLarge");
    }

    if (code === "invalid_asset") {
      return t("staff.themes.assets.invalid");
    }

    if (code === "invalid_key") {
      return t("staff.themes.strings.invalid");
    }

    if (code === "not_found") {
      return t("staff.themes.error.not_found");
    }

    if (code === "protected_theme") {
      return t("staff.themes.error.protected_theme");
    }

    if (code === "duplicate_name") {
      return t("staff.themes.error.duplicate_name");
    }

    if (code === "invalid_name") {
      return t("staff.themes.error.invalid_name");
    }

    return t("staff.themes.error.failed");
  };

  const run = async (work: () => Promise<void>, onSuccess: () => void): Promise<void> => {
    setBusy(true);
    setError(null);

    try {
      await work();
      onSuccess();
      await refresh();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const template = theme?.templates.find((entry) => entry.name === templateName) ?? null;
  const versions = (theme?.versions ?? []).filter((entry) => entry.name === templateName);

  const selectTemplate = (name: string): void => {
    setTemplateName(name);
    setTemplateBody(theme?.templates.find((entry) => entry.name === name)?.body ?? "");
    setVersion("");
    setError(null);
  };

  const createChild = (): void => {
    void run(
      async () => {
        const outcome = await apiPost<{ id: string }>("/api/staff/themes", {
          name: childName,
          parentId: childParent,
        });
        setChildName("");
        setSelected(outcome.id);
        setTab("templates");
      },
      () => toast.pushToast({ messageKey: "staff.themes.create.saved", tone: "success" }),
    );
  };

  const saveTemplate = (): void => {
    if (theme === null) {
      return;
    }

    void run(
      async () => {
        await apiPost("/api/staff/themes/template", {
          themeId: theme.id,
          name: templateName,
          body: templateBody,
        });
      },
      () => toast.pushToast({ messageKey: "staff.themes.template.saved", tone: "success" }),
    );
  };

  const renderValidation = (caught: unknown): string => {
    const body = errorBody(caught);
    const issues = Array.isArray(body.issues) ? (body.issues as TemplateIssue[]) : [];
    const lines = issues.map((issue) =>
      t("template.validation.line", {
        line: issue.line,
        message: t(`template.validation.${issue.code}`, {
          element: issue.element,
          attribute: issue.attribute ?? "",
          scheme: issue.detail ?? "",
          tag: issue.element,
        }),
      }),
    );
    const parseError = typeof body.parseError === "string" ? body.parseError : null;
    const unknownHooks = Array.isArray(body.unknownHooks) ? body.unknownHooks : [];

    if (parseError !== null) {
      lines.push(t("staff.themes.error.parse", { message: parseError }));
    }

    for (const hook of unknownHooks) {
      lines.push(t("staff.themes.error.hook", { hook: String(hook) }));
    }

    return [t("staff.themes.template.validation"), ...lines].join(" ");
  };

  const restore = (): void => {
    if (theme === null || version === "") {
      return;
    }

    void run(
      async () => {
        await apiPost("/api/staff/themes/template/restore", {
          themeId: theme.id,
          name: templateName,
          version: Number(version),
        });
        setVersion("");
      },
      () => toast.pushToast({ messageKey: "staff.themes.template.restored", tone: "success" }),
    );
  };

  const revert = (): void => {
    if (theme === null) {
      return;
    }

    void run(
      async () => {
        await apiPost("/api/staff/themes/template/revert", {
          themeId: theme.id,
          name: templateName,
        });
      },
      () => toast.pushToast({ messageKey: "staff.themes.template.reverted", tone: "success" }),
    );
  };

  const saveTokens = (scheme: Scheme): void => {
    if (theme === null) {
      return;
    }

    void run(
      async () => {
        await apiPost("/api/staff/themes/tokens", {
          themeId: theme.id,
          scheme,
          tokens: tokens[scheme],
        });
      },
      () => toast.pushToast({ messageKey: "staff.themes.tokens.saved", tone: "success" }),
    );
  };

  const saveCss = (): void => {
    if (theme === null) {
      return;
    }

    void run(
      async () => {
        const result = await apiPost<{ css: string }>("/api/staff/themes/css", {
          themeId: theme.id,
          css,
        });
        setCss(result.css);
      },
      () => toast.pushToast({ messageKey: "staff.themes.css.saved", tone: "success" }),
    );
  };

  const upload = async (file: File): Promise<void> => {
    if (theme === null) {
      return;
    }

    const name = file.name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (name === "") {
      setError(t("staff.themes.assets.invalid"));
      return;
    }

    setAssetName(name);
    void run(
      async () => {
        await apiPost("/api/staff/themes/assets", {
          themeId: theme.id,
          name,
          data: await base64(file),
        });
        setAssetName("");
      },
      () => toast.pushToast({ messageKey: "staff.themes.assets.saved", tone: "success" }),
    );
  };

  const removeAsset = (asset: AssetView): void => {
    if (theme === null) {
      return;
    }

    void run(
      async () => {
        await apiDelete("/api/staff/themes/assets", {
          themeId: theme.id,
          assetId: asset.id,
        });
      },
      () => toast.pushToast({ messageKey: "staff.themes.assets.saved", tone: "success" }),
    );
  };

  const saveStrings = (): void => {
    if (theme === null) {
      return;
    }

    const usable = strings.filter((entry) => entry.key.trim() !== "");

    void run(
      async () => {
        await apiPost("/api/staff/themes/strings", {
          themeId: theme.id,
          strings: usable,
        });
      },
      () => toast.pushToast({ messageKey: "staff.themes.strings.saved", tone: "success" }),
    );
  };

  const preview = (): void => {
    if (theme === null) {
      return;
    }

    void run(
      async () => {
        const result = await apiPost<{ url: string }>("/api/staff/themes/preview", {
          themeId: theme.id,
          returnTo: "/",
        });
        setPreviewUrl(result.url);
      },
      () => toast.pushToast({ messageKey: "staff.themes.preview.ready", tone: "success" }),
    );
  };

  const updateString = (index: number, patch: Partial<StringView>): void => {
    setStrings((current) =>
      current.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)),
    );
  };

  return (
    <div className="page" data-page="themes">
      <header className="page-header">
        <h1>{t("staff.themes.title")}</h1>
        <p>{t("staff.themes.intro")}</p>
      </header>

      {error !== null ? (
        <p className="form-error" role="alert" data-themes-error>
          {error}
        </p>
      ) : null}

      {selected === null ? (
        <>
          <section className="admin-panel">
            <h2>{t("staff.themes.create.title")}</h2>
            <div className="admin-form" data-theme-create>
              <label>
                <span>{t("staff.themes.create.name")}</span>
                <input
                  value={childName}
                  maxLength={60}
                  data-theme-create-name
                  onChange={(event) => setChildName(event.target.value)}
                />
              </label>
              <label>
                <span>{t("staff.themes.create.parent")}</span>
                <select
                  value={childParent}
                  data-theme-create-parent
                  onChange={(event) => setChildParent(event.target.value)}
                >
                  {(list.data?.themes ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="admin-form__actions">
                <button
                  type="button"
                  data-theme-create-submit
                  disabled={busy || childName.trim() === ""}
                  onClick={createChild}
                >
                  {t("staff.themes.create.submit")}
                </button>
              </div>
            </div>
          </section>

          <section className="admin-panel">
            <ul className="admin-list" data-theme-list>
              {(list.data?.themes ?? []).map((entry) => (
                <li key={entry.id} data-theme-row={entry.id}>
                  <strong>{entry.name}</strong>
                  <span className="widget-muted">
                    {entry.parentName === null
                      ? "—"
                      : `${t("staff.themes.column.parent")}: ${entry.parentName}`}{" "}
                    · {t("staff.themes.column.version")}: {entry.version} ·{" "}
                    {sourceLabel(t, entry.source)}
                  </span>
                  <button
                    type="button"
                    data-theme-edit={entry.id}
                    onClick={() => {
                      setSelected(entry.id);
                      setPreviewUrl(null);
                    }}
                  >
                    {t("staff.themes.edit")}
                  </button>
                </li>
              ))}
            </ul>
            {(list.data?.themes ?? []).length === 0 ? (
              <p className="widget-muted">{t("staff.themes.empty")}</p>
            ) : null}
          </section>
        </>
      ) : null}

      {selected !== null && theme !== null ? (
        <section className="admin-panel" data-theme-editor data-theme-id={theme.id}>
          <header className="page-header">
            <button type="button" className="button-quiet" onClick={() => setSelected(null)}>
              {t("staff.themes.back")}
            </button>
            <h2>
              {theme.name}{" "}
              <span className="widget-muted">
                {t("staff.themes.column.version")}: {theme.version} · {sourceLabel(t, theme.source)}
              </span>
            </h2>
            {!theme.editable ? (
              <p className="widget-muted">{t("staff.themes.template.protected")}</p>
            ) : null}
            <button type="button" data-theme-preview disabled={busy} onClick={preview}>
              {t("staff.themes.preview")}
            </button>
            {previewUrl !== null ? (
              <a href={previewUrl} target="_blank" rel="noreferrer" data-theme-preview-link>
                {t("staff.themes.preview.link")}
              </a>
            ) : null}
          </header>

          <nav className="theme-tabs" data-theme-tabs>
            {(
              [
                { id: "templates", labelKey: "staff.themes.tab.templates" },
                { id: "tokens", labelKey: "staff.themes.tab.tokens" },
                { id: "css", labelKey: "staff.themes.tab.css" },
                { id: "assets", labelKey: "staff.themes.tab.assets" },
                { id: "strings", labelKey: "staff.themes.tab.strings" },
              ] as const
            ).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={tab === entry.id ? "button-quiet is-active" : "button-quiet"}
                data-theme-tab={entry.id}
                onClick={() => setTab(entry.id)}
              >
                {t(entry.labelKey)}
              </button>
            ))}
          </nav>

          {tab === "templates" ? (
            <div data-theme-panel="templates">
              <label>
                <span>{t("staff.themes.template.select")}</span>
                <select
                  data-theme-template-select
                  value={templateName}
                  onChange={(event) => selectTemplate(event.target.value)}
                >
                  {theme.templates.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              {template?.inheritedFrom !== null && template !== null ? (
                <p className="widget-muted" data-theme-inherited>
                  {t("staff.themes.template.inherited", { theme: template.inheritedFrom })}
                </p>
              ) : null}
              <label>
                <span>{t("staff.themes.template.current")}</span>
                <textarea
                  rows={14}
                  value={templateBody}
                  data-theme-template-body
                  disabled={!theme.editable}
                  onChange={(event) => setTemplateBody(event.target.value)}
                />
              </label>
              <div className="admin-form__actions">
                <button
                  type="button"
                  data-theme-template-save
                  disabled={busy || !theme.editable}
                  onClick={saveTemplate}
                >
                  {t("staff.themes.template.save")}
                </button>
                {template?.canRevert === true ? (
                  <button
                    type="button"
                    className="button-quiet"
                    data-theme-template-revert
                    disabled={busy}
                    onClick={revert}
                  >
                    {t("staff.themes.template.revert")}
                  </button>
                ) : null}
                <select
                  value={version}
                  data-theme-version-select
                  onChange={(event) => setVersion(event.target.value)}
                >
                  <option value="">{t("staff.themes.template.versions")}</option>
                  {versions.map((entry) => (
                    <option key={entry.version} value={entry.version}>
                      v{entry.version}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-theme-version-restore
                  disabled={busy || version === "" || !theme.editable}
                  onClick={restore}
                >
                  {t("staff.themes.template.restore")}
                </button>
              </div>
              {template?.parentBody !== null && template !== null ? (
                <>
                  <h3>{t("staff.themes.template.diff")}</h3>
                  <pre className="theme-diff" data-theme-diff>
                    {diffLines(template.parentBody ?? "", templateBody).map((line, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable id
                      <span key={`${line.kind}-${index}`} className={`diff-${line.kind}`}>
                        {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                        {line.text}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                </>
              ) : null}
              {template?.parentBody !== null && template !== null ? (
                <>
                  <h3>{t("staff.themes.template.parent")}</h3>
                  <pre className="theme-diff">{template.parentBody}</pre>
                </>
              ) : null}
            </div>
          ) : null}

          {tab === "tokens" ? (
            <div data-theme-panel="tokens">
              <p className="widget-muted">{t("staff.themes.tokens.intro")}</p>
              {(["light", "dark"] as const).map((scheme) => (
                <fieldset key={scheme} className="admin-form" data-theme-tokens={scheme}>
                  <legend>
                    {scheme === "light"
                      ? t("staff.themes.tokens.light")
                      : t("staff.themes.tokens.dark")}
                  </legend>
                  {TOKEN_KEYS.map((key) => (
                    <label key={key}>
                      <span>{`--bl-${key}`}</span>
                      <input
                        value={tokens[scheme][key] ?? ""}
                        data-theme-token={key}
                        onChange={(event) =>
                          setTokens((current) => ({
                            ...current,
                            [scheme]: { ...current[scheme], [key]: event.target.value },
                          }))
                        }
                      />
                    </label>
                  ))}
                  <div className="admin-form__actions">
                    <button
                      type="button"
                      data-theme-tokens-save={scheme}
                      disabled={busy}
                      onClick={() => saveTokens(scheme)}
                    >
                      {t("staff.themes.tokens.save")}
                    </button>
                  </div>
                </fieldset>
              ))}
            </div>
          ) : null}

          {tab === "css" ? (
            <div data-theme-panel="css">
              <p className="widget-muted">{t("staff.themes.css.intro")}</p>
              <textarea
                rows={14}
                value={css}
                data-theme-css
                onChange={(event) => setCss(event.target.value)}
              />
              <div className="admin-form__actions">
                <button type="button" data-theme-css-save disabled={busy} onClick={saveCss}>
                  {t("staff.themes.css.save")}
                </button>
              </div>
            </div>
          ) : null}

          {tab === "assets" ? (
            <div data-theme-panel="assets">
              <p className="widget-muted">{t("staff.themes.assets.intro")}</p>
              <label>
                <span>{t("staff.themes.assets.upload")}</span>
                <input
                  type="file"
                  data-theme-asset-input
                  onChange={(event) => {
                    const file = event.target.files?.[0];

                    if (file !== undefined) {
                      void upload(file);
                    }
                  }}
                />
              </label>
              {assetName !== "" ? <p className="widget-muted">{assetName}</p> : null}
              <ul className="admin-list" data-theme-assets>
                {theme.assets.map((asset) => (
                  <li key={asset.id} data-theme-asset={asset.id}>
                    <a href={assetUrl(asset.name)} target="_blank" rel="noreferrer">
                      {asset.name}
                    </a>
                    <span className="widget-muted">
                      {asset.contentType} · {bytesLabel(asset.bytes)}
                    </span>
                    <button
                      type="button"
                      className="button-quiet"
                      data-theme-asset-delete={asset.id}
                      onClick={() => removeAsset(asset)}
                    >
                      {t("staff.themes.assets.delete")}
                    </button>
                  </li>
                ))}
              </ul>
              {theme.assets.length === 0 ? (
                <p className="widget-muted">{t("staff.themes.assets.empty")}</p>
              ) : null}
            </div>
          ) : null}

          {tab === "strings" ? (
            <div data-theme-panel="strings">
              <p className="widget-muted">{t("staff.themes.strings.intro")}</p>
              <div className="admin-list" data-theme-strings>
                {strings.map((entry, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
                  <div className="admin-form" key={`${index}-${entry.key}`}>
                    <label>
                      <span>{t("staff.themes.strings.locale")}</span>
                      <select
                        value={entry.locale}
                        data-theme-string-locale
                        onChange={(event) =>
                          updateString(index, { locale: event.target.value as Locale })
                        }
                      >
                        <option value="en">{t("staff.locale.en")}</option>
                        <option value="es">{t("staff.locale.es")}</option>
                        <option value="fr">{t("staff.locale.fr")}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t("staff.themes.strings.key")}</span>
                      <input
                        value={entry.key}
                        data-theme-string-key
                        onChange={(event) => updateString(index, { key: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{t("staff.themes.strings.value")}</span>
                      <input
                        value={entry.value}
                        data-theme-string-value
                        onChange={(event) => updateString(index, { value: event.target.value })}
                      />
                    </label>
                  </div>
                ))}
              </div>
              <div className="admin-form__actions">
                <button
                  type="button"
                  className="button-quiet"
                  data-theme-string-add
                  onClick={() =>
                    setStrings((current) => [...current, { locale: "en", key: "", value: "" }])
                  }
                >
                  {t("staff.themes.strings.add")}
                </button>
                <button type="button" data-theme-strings-save disabled={busy} onClick={saveStrings}>
                  {t("staff.themes.strings.save")}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
