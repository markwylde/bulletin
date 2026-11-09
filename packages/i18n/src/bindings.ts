import { formatMessage, type Locale, type MessageValues } from "./catalog.ts";
import { type RuntimeMessageInput, resolveRuntimeMessage } from "./runtime.ts";

export type Translator = (key: string, values?: MessageValues) => string;

export type ServerTranslatorOptions = Omit<RuntimeMessageInput, "key" | "locale">;

/**
 * Creates the server-side translator used by emails, push and templates. It applies the same
 * override/theme/plugin/shipped lookup order as the React binding.
 */
export function createServerT(locale: Locale, options: ServerTranslatorOptions = {}): Translator {
  return (key, values = {}) => {
    const message = resolveRuntimeMessage({ key, locale, ...options });
    return message === undefined ? key : formatMessage(locale, message, values);
  };
}

/** One-shot server translation for a single email or push message. */
export function serverT(
  locale: Locale,
  key: string,
  values: MessageValues = {},
  options: ServerTranslatorOptions = {},
): string {
  return createServerT(locale, options)(key, values);
}
