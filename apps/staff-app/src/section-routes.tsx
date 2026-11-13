import type { ComponentType } from "react";
import { AnnouncementsPage } from "./announcements/AnnouncementsPage.tsx";
import { BadgesPage } from "./badges/BadgesPage.tsx";
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
import { MemberProfilesPage } from "./members/MemberProfilesPage.tsx";
import { MemberReputationPage } from "./members/MemberReputationPage.tsx";
import { ProfileFieldsPage } from "./members/ProfileFieldsPage.tsx";
import { BansPage } from "./moderation/BansPage.tsx";
import { FiltersPage } from "./moderation/FiltersPage.tsx";
import { ModerationLogPage } from "./moderation/ModerationLogPage.tsx";
import { ModerationPage } from "./moderation/ModerationPage.tsx";
import { MultimodPage } from "./moderation/MultimodPage.tsx";
import { WarningsPage } from "./moderation/WarningsPage.tsx";
import { ModeratorsPage } from "./moderators/ModeratorsPage.tsx";
import { MasksPage } from "./permissions/MasksPage.tsx";
import { PluginsPage } from "./plugins/PluginsPage.tsx";
import { PromotionsPage } from "./promotions/PromotionsPage.tsx";
import { RanksPage } from "./ranks/RanksPage.tsx";
import { ReactionsPage } from "./reactions/ReactionsPage.tsx";
import type { StaffSection } from "./sections.ts";
import { BoardSettingsPage } from "./settings/BoardSettingsPage.tsx";
import { StringOverridesPage } from "./strings/StringOverridesPage.tsx";
import { ThemesPage } from "./themes/ThemesPage.tsx";
import { WebhooksPage } from "./webhooks/WebhooksPage.tsx";

/** The route component for each section id. */
export const SECTION_ELEMENTS: Readonly<Record<string, ComponentType>> = {
  dashboard: DashboardPage,
  moderation: ModerationPage,
  moderationLog: ModerationLogPage,
  bans: BansPage,
  multimod: MultimodPage,
  warnings: WarningsPage,
  adminLog: AdminLogPage,
  deadLetters: DeadLettersPage,
  boardSettings: BoardSettingsPage,
  emoticons: EmoticonsPage,
  filters: FiltersPage,
  stringOverrides: StringOverridesPage,
  flags: FlagsPage,
  groups: GroupsPage,
  groupSettings: GroupSettingsPage,
  permissions: MasksPage,
  memberGroups: MemberGroupsPage,
  memberReputation: MemberReputationPage,
  memberProfiles: MemberProfilesPage,
  profileFields: ProfileFieldsPage,
  ranks: RanksPage,
  badges: BadgesPage,
  moderators: ModeratorsPage,
  promotions: PromotionsPage,
  reactions: ReactionsPage,
  forums: ForumsPage,
  prefixes: PrefixesPage,
  announcements: AnnouncementsPage,
  themes: ThemesPage,
  plugins: PluginsPage,
  webhooks: WebhooksPage,
};

export function sectionElement(section: StaffSection): ComponentType | null {
  return SECTION_ELEMENTS[section.id] ?? null;
}
