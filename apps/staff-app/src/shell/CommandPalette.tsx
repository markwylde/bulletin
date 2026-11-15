import { useT } from "@bulletin/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { StaffAreaView, StaffSection } from "../sections.ts";
import { IconArrowRight, IconSearch } from "../ui/icons.tsx";
import { AREA_ICONS } from "./navigation.tsx";

interface Entry {
  readonly section: StaffSection;
  readonly label: string;
  readonly area: string;
  readonly group: string;
  readonly haystack: string;
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Ranks label prefix matches first, then word starts, then anywhere in area/group/label. */
export function matchSections<T extends { label: string; haystack: string }>(
  entries: readonly T[],
  query: string,
): T[] {
  const needle = fold(query.trim());

  if (needle === "") {
    return [...entries];
  }

  const scored: { entry: T; score: number }[] = [];

  for (const entry of entries) {
    const label = fold(entry.label);
    let score = -1;

    if (label.startsWith(needle)) {
      score = 0;
    } else if (label.split(/\s+/).some((word) => word.startsWith(needle))) {
      score = 1;
    } else if (label.includes(needle)) {
      score = 2;
    } else if (entry.haystack.includes(needle)) {
      score = 3;
    }

    if (score >= 0) {
      scored.push({ entry, score });
    }
  }

  return scored.sort((a, b) => a.score - b.score).map((item) => item.entry);
}

export function useCommandShortcut(onOpen: () => void): void {
  const callback = useRef(onOpen);
  callback.current = onOpen;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        callback.current();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** Jump to any staff section you can open (⌘K / Ctrl-K). */
export function CommandPalette({
  areas,
  open,
  onClose,
}: {
  readonly areas: readonly StaffAreaView[];
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const entries = useMemo<Entry[]>(
    () =>
      areas.flatMap((view) =>
        view.groups.flatMap((group) =>
          group.sections.map((section) => {
            const label = t(section.labelKey);
            const area = t(view.area.labelKey);
            const groupLabel = t(group.group.labelKey);

            return {
              section,
              label,
              area,
              group: groupLabel,
              haystack: fold(`${label} ${area} ${groupLabel}`),
            };
          }),
        ),
      ),
    [areas, t],
  );
  const results = useMemo(() => matchSections(entries, query), [entries, query]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (dialog === null) {
      return;
    }

    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    document.getElementById(`${listId}-option-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  const choose = (entry: Entry | undefined) => {
    if (entry === undefined) {
      return;
    }

    onClose();
    navigate(entry.section.path);
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a backdrop click closes; Escape is handled by onCancel
    <dialog
      ref={dialogRef}
      className="command"
      data-command-palette
      aria-label={t("staff.search.label")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="command-input">
        <IconSearch size={18} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={results.length > 0 ? `${listId}-option-${active}` : undefined}
          aria-label={t("staff.search.label")}
          placeholder={t("staff.search.placeholder")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          data-command-input
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(results.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results[active]);
            }
          }}
        />
        <kbd className="command-esc">{t("staff.search.escape")}</kbd>
      </div>
      {results.length === 0 ? (
        <p className="command-empty" data-command-empty>
          {t("staff.search.empty")}
        </p>
      ) : (
        <div
          id={listId}
          className="command-list"
          role="listbox"
          aria-label={t("staff.search.label")}
        >
          {results.map((entry, index) => {
            const Icon = AREA_ICONS[entry.section.area];

            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the combobox input
              <div
                key={entry.section.id}
                tabIndex={-1}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === active}
                className="command-option"
                data-command-option={entry.section.id}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(entry)}
              >
                <span className="command-option-icon">
                  <Icon size={16} />
                </span>
                <span className="command-option-label">{entry.label}</span>
                <span className="command-option-path">
                  {entry.area} · {entry.group}
                </span>
                <IconArrowRight size={14} className="command-option-go" />
              </div>
            );
          })}
        </div>
      )}
    </dialog>
  );
}
