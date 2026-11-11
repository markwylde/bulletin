import {
  isRasterAttachmentType,
  type PostAttachmentRecord,
  SVG_ATTACHMENT_TYPE,
} from "@bulletin/domain/attachments";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml, type SafeHtml, safeHtml } from "@bulletin/templates";

export interface PostAttachmentRenderInput {
  readonly postId: string;
  readonly html: string;
  readonly attachments: readonly PostAttachmentRecord[];
  readonly locale: Locale;
  readonly translate: Translator;
  /** Moderators with `edit` get a remove control on every attachment. */
  readonly canRemove: boolean;
  /** Off removes placeholders and the file list entirely (the `attachments` flag). */
  readonly enabled?: boolean;
}

export interface PostAttachmentRender {
  readonly bodyHtml: string;
  readonly files: SafeHtml | null;
}

const ATTACHMENT_TAG = /<bl-attachment\b([^>]*)>(?:<\/bl-attachment>)?/gi;

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

/** `/attachments/<id>/<filename>` — the filename is cosmetic; the route resolves by ID. */
export function attachmentPath(id: string, filename: string): string {
  return `/attachments/${id}/${encodeURIComponent(filename)}`;
}

/** Raster preview for an SVG attachment; the original remains download-only (ADR 0019). */
export function attachmentPreviewPath(id: string): string {
  return `/attachments/${id}?preview=1`;
}

/** Localised short file size via Intl units (no hard-coded "MB" strings). */
export function formatFileSize(bytes: number, locale: Locale): string {
  const value = Math.max(0, bytes);

  if (value < 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "byte",
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(value);
  }

  if (value < 1024 * 1024) {
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(value / 1024);
  }

  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value / (1024 * 1024));
}

function removeButton(id: string, translate: Translator, canRemove: boolean): string {
  return canRemove
    ? `<button class="bl-button bl-button--quiet bl-button--small" type="button" data-attachment-remove="${id}">${escapeHtml(
        translate("attachment.remove"),
      )}</button>`
    : "";
}

/**
 * Replaces `<bl-attachment>` placeholders with inline images and builds the file list below
 * the post (ADR 0019). Only attachments linked to this post can resolve; anything else is the
 * translated "attachment removed" marker, including after a cached block was invalidated.
 */
export function renderPostAttachments(input: PostAttachmentRenderInput): PostAttachmentRender {
  if (input.enabled === false) {
    return { bodyHtml: input.html.replace(ATTACHMENT_TAG, ""), files: null };
  }

  const byId = new Map(input.attachments.map((attachment) => [attachment.id, attachment]));
  const inline = new Set<string>();
  const bodyHtml = input.html.replace(ATTACHMENT_TAG, (_match, rawAttributes: string) => {
    const id = attribute(rawAttributes, "data-id");
    const attachment = id === null ? undefined : byId.get(id);

    if (id === null || attachment === undefined) {
      return `<span class="bl-attachment-missing">${escapeHtml(
        input.translate("attachment.removed"),
      )}</span>`;
    }

    if (attribute(rawAttributes, "data-inline") !== "true") {
      return "";
    }

    const isSvg = attachment.contentType === SVG_ATTACHMENT_TYPE;

    if (!isRasterAttachmentType(attachment.contentType) && !isSvg) {
      // Documents stay download-only; they appear in the file list instead.
      return "";
    }

    inline.add(attachment.id);
    const href = escapeHtml(attachmentPath(attachment.id, attachment.filename));
    const src = isSvg ? escapeHtml(attachmentPreviewPath(attachment.id)) : href;

    return [
      `<figure class="bl-attachment-image" data-attachment="${attachment.id}">`,
      `<a href="${href}" data-attachment-download="${attachment.id}">`,
      `<img src="${src}" alt="${escapeHtml(attachment.filename)}" loading="lazy" decoding="async">`,
      "</a>",
      removeButton(attachment.id, input.translate, input.canRemove),
      "</figure>",
    ].join("");
  });

  const files = input.attachments.filter((attachment) => !inline.has(attachment.id));

  if (files.length === 0) {
    return { bodyHtml, files: null };
  }

  const items = files.map((attachment) => {
    const href = escapeHtml(attachmentPath(attachment.id, attachment.filename));

    return [
      `<li class="bl-attachment-file" data-attachment="${attachment.id}">`,
      `<a class="bl-attachment-file__name" href="${href}" data-attachment-download="${attachment.id}">${escapeHtml(
        attachment.filename,
      )}</a>`,
      `<span class="bl-attachment-file__meta">${escapeHtml(
        formatFileSize(attachment.sizeBytes, input.locale),
      )} · ${escapeHtml(
        input.translate("attachment.downloads", { count: attachment.downloadCount }),
      )}</span>`,
      removeButton(attachment.id, input.translate, input.canRemove),
      "</li>",
    ].join("");
  });

  return {
    bodyHtml,
    files: safeHtml(
      `<ul class="bl-attachment-list" data-post-attachments="${input.postId}">${items.join(
        "",
      )}</ul>`,
    ),
  };
}
