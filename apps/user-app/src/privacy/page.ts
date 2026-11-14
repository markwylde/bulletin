import { readPrivacyPolicy, retainedErasureCategories } from "@bulletin/domain/privacy";
import type { Translator } from "@bulletin/i18n";
import { safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

function retainedLabel(translate: Translator, key: string): string {
  switch (key) {
    case "dataRequests":
      return translate("privacy.erasure.retained.dataRequests");
    case "accessLog":
      return translate("privacy.erasure.retained.accessLog");
    case "moderationLog":
      return translate("privacy.erasure.retained.moderationLog");
    case "warnings":
      return translate("privacy.erasure.retained.warnings");
    case "ban":
      return translate("privacy.erasure.retained.ban");
    default:
      return key;
  }
}

export interface PrivacyPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly translate: Translator;
}

export interface PrivacyPageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly hasPolicy: boolean;
    readonly policyHtml: unknown;
    readonly retained: readonly { readonly key: string; readonly basis: string }[];
  };
}

export interface PrivacyLabels {
  readonly exportRequested: string;
  readonly exportError: string;
  readonly erasureRequested: string;
  readonly erasureError: string;
  readonly loading: string;
  readonly loadError: string;
  readonly noRequests: string;
  readonly download: string;
  readonly kinds: Readonly<Record<string, string>>;
  readonly statuses: Readonly<Record<string, string>>;
}

export function privacyLabels(translate: Translator): PrivacyLabels {
  return {
    exportRequested: translate("account.privacy.exportRequested"),
    exportError: translate("account.privacy.exportError"),
    erasureRequested: translate("account.privacy.erasureRequested"),
    erasureError: translate("account.privacy.erasureError"),
    loading: translate("account.privacy.loading"),
    loadError: translate("account.privacy.loadError"),
    noRequests: translate("account.privacy.noRequests"),
    download: translate("account.privacy.download"),
    kinds: {
      export: translate("account.privacy.kind.export"),
      erasure: translate("account.privacy.kind.erasure"),
    },
    statuses: {
      pending: translate("account.privacy.status.pending"),
      processing: translate("account.privacy.status.processing"),
      completed: translate("account.privacy.status.completed"),
      rejected: translate("account.privacy.status.rejected"),
    },
  };
}

export async function buildPrivacyPage(input: PrivacyPageInput): Promise<PrivacyPageData> {
  const [policy, retained] = await Promise.all([
    readPrivacyPolicy(input.sql),
    retainedErasureCategories(input.sql, input.memberId),
  ]);
  const title = input.translate("account.privacy.title");

  return {
    title,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: title, href: null },
    ],
    viewModel: {
      hasPolicy: policy.html.trim() !== "",
      policyHtml: safeHtml(policy.html),
      retained: retained.map((category) => ({
        key: category.key,
        basis: retainedLabel(input.translate, category.key),
      })),
    },
  };
}
