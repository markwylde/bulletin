import { useEffect, useRef } from "react";
import { useFlag } from "../flags.tsx";

export interface ApiDocsProps {
  readonly url: string;
}

/**
 * Scalar mounts only for viewers with the `public_api` flag (ADR 0010, 0016). The server route
 * already returns 404 when the flag is off; this keeps an island rendered from a stale fragment
 * from showing documentation for a feature that is no longer available.
 */
export function ApiDocs({ url }: ApiDocsProps) {
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

        createApiReference(target.current, { url, withDefaultFonts: false });
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
  }, [enabled, url]);

  return <div id="api-reference" data-api-reference data-url={url} ref={target} />;
}
