import { useEffect, useRef } from "react";
import { useFlag } from "../flags.tsx";

export interface ApiDocsProps {
  /** The generated OpenAPI document as JSON text, embedded in the page (ADR 0016). */
  readonly content: string;
}

/**
 * Scalar mounts only for viewers with the `public_api` flag (ADR 0010, 0016). The route already
 * returns 404 when the flag is off; this keeps an island rendered from a stale fragment from
 * showing documentation for a feature that is no longer available.
 *
 * The document arrives in the props instead of being fetched: `/api/v1` sees a guest request
 * from the browser, so a rollout that is on for Members and off for Guests would 404 the fetch
 * even though the page is allowed.
 */
export function ApiDocs({ content }: ApiDocsProps) {
  const enabled = useFlag("public_api");
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled || target.current === null) {
      return;
    }

    let cancelled = false;
    const status = document.querySelector<HTMLElement>("[data-api-reference-status]");

    void import("@scalar/api-reference")
      .then(async ({ createApiReference }) => {
        await import("@scalar/api-reference/style.css");

        if (cancelled || target.current === null) {
          return;
        }

        createApiReference(target.current, { content, withDefaultFonts: false });
        status?.remove();
      })
      .catch(() => {
        if (status !== null) {
          status.textContent = status.dataset.error ?? "";
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, content]);

  return <div id="api-reference" data-api-reference ref={target} />;
}
