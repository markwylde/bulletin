export interface AnnouncementTarget {
  readonly forumId: string;
  readonly includeSubforums: boolean;
}

export interface AnnouncementRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly scope: "global" | "forums";
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly dismissible: boolean;
  readonly version: number;
  readonly targets: readonly AnnouncementTarget[];
  readonly groupIds: readonly string[];
}

export interface AnnouncementDraft {
  readonly id: string | null;
  readonly title: string;
  readonly body: string;
  readonly scope: "global" | "forums";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly dismissible: boolean;
  readonly targets: readonly AnnouncementTarget[];
  readonly groupIds: readonly string[];
}

/** `datetime-local` wants local wall time, while the API uses ISO instants. */
export function localInput(iso: string | null): string {
  if (iso === null) {
    return "";
  }

  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function emptyDraft(now: Date = new Date()): AnnouncementDraft {
  return {
    id: null,
    title: "",
    body: "",
    scope: "global",
    startsAt: localInput(now.toISOString()),
    endsAt: "",
    dismissible: true,
    targets: [],
    groupIds: [],
  };
}

/** Preserves each target's sub-forum choice; mixed announcements must round-trip unchanged. */
export function draftFrom(announcement: AnnouncementRecord): AnnouncementDraft {
  return {
    id: announcement.id,
    title: announcement.title,
    body: announcement.body,
    scope: announcement.scope,
    startsAt: localInput(announcement.startsAt),
    endsAt: localInput(announcement.endsAt),
    dismissible: announcement.dismissible,
    targets: announcement.targets.map((target) => ({
      forumId: target.forumId,
      includeSubforums: target.includeSubforums,
    })),
    groupIds: announcement.groupIds,
  };
}

export function iso(value: string): string | null {
  if (value.trim() === "") {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function payloadFromDraft(draft: AnnouncementDraft): Record<string, unknown> {
  return {
    action: "save",
    ...(draft.id === null ? {} : { id: draft.id }),
    title: draft.title,
    body: draft.body,
    scope: draft.scope,
    startsAt: iso(draft.startsAt),
    endsAt: iso(draft.endsAt),
    dismissible: draft.dismissible,
    targets: draft.scope === "forums" ? draft.targets : [],
    groupIds: draft.groupIds,
  };
}
