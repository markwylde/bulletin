import { saveOfflineDraft } from "@bulletin/ui/islands/editor/offline-drafts";
import { currentMemberId } from "../auth/client.ts";
import { draftContext } from "./client.ts";

/** A fetch that rejects (or a browser that already reports offline) is a lost connection. */
export function isNetworkFailure(error: unknown): boolean {
  return !navigator.onLine || error instanceof TypeError;
}

/**
 * Keeps a failed submission on the device and wakes the reconnect prompt. Returns false when
 * no member is known or the store refused the write, in which case the form still shows an
 * error and the text stays in the editor.
 */
export async function queueOfflineSubmission(
  form: HTMLFormElement,
  url: string,
  payload: unknown,
): Promise<boolean> {
  const draft = await saveOfflineDraft({
    memberId: currentMemberId(),
    contextKey: draftContext(form),
    url,
    body: JSON.stringify(payload),
  });

  if (draft === null) {
    return false;
  }

  window.dispatchEvent(new CustomEvent("bulletin:offline-draft", { detail: { draft } }));
  return true;
}
