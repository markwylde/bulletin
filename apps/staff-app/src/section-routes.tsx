import type { ComponentType } from "react";
import { AnnouncementsPage } from "./announcements/AnnouncementsPage.tsx";
import { DashboardPage } from "./dashboard/DashboardPage.tsx";
import { EmoticonsPage } from "./emoticons/EmoticonsPage.tsx";
import { DeadLettersPage } from "./events/DeadLettersPage.tsx";
import { FlagsPage } from "./flags/FlagsPage.tsx";
import { ForumsPage } from "./forums/ForumsPage.tsx";
import { PrefixesPage } from "./forums/PrefixesPage.tsx";
import { GroupSettingsPage } from "./groups/GroupSettingsPage.tsx";
import { GroupsPage } from "./groups/GroupsPage.tsx";
import { AdminLogPage } from "./log/AdminLogPage.tsx";
import { MemberGroupsPage } from "./members/MemberGroupsPage.tsx";
import { MemberReputationPage } from "./members/MemberReputationPage.tsx";
import { ModeratorsPage } from "./moderators/ModeratorsPage.tsx";
import { MasksPage } from "./permissions/MasksPage.tsx";
import { PromotionsPage } from "./promotions/PromotionsPage.tsx";
import { ReactionsPage } from "./reactions/ReactionsPage.tsx";
import type { StaffSection } from "./sections.ts";
import { BoardSettingsPage } from "./settings/BoardSettingsPage.tsx";
import { StringOverridesPage } from "./strings/StringOverridesPage.tsx";

/** The route component for each section id. */
export const SECTION_ELEMENTS: Readonly<Record<string, ComponentType>> = {
  dashboard: DashboardPage,
  adminLog: AdminLogPage,
  deadLetters: DeadLettersPage,
  boardSettings: BoardSettingsPage,
  emoticons: EmoticonsPage,
  stringOverrides: StringOverridesPage,
  flags: FlagsPage,
  groups: GroupsPage,
  groupSettings: GroupSettingsPage,
  permissions: MasksPage,
  memberGroups: MemberGroupsPage,
  memberReputation: MemberReputationPage,
  moderators: ModeratorsPage,
  promotions: PromotionsPage,
  reactions: ReactionsPage,
  forums: ForumsPage,
  prefixes: PrefixesPage,
  announcements: AnnouncementsPage,
};

export function sectionElement(section: StaffSection): ComponentType | null {
  return SECTION_ELEMENTS[section.id] ?? null;
}
