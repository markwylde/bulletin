# Spec Delta

## Purpose

Lets every person use Bulletin in English, Spanish or French. It also lets admins adjust
wording, and keeps cached pages deterministic per locale.

## ADDED Requirements

### Requirement: Supported locales
The user app, staff app, emails and push notifications SHALL be fully available in English (`en`), Spanish (`es`) and French (`fr`). The board default locale SHALL be configurable by admins.

#### Scenario: Spanish member
- **WHEN** a member with locale preference `es` views any page
- **THEN** all interface text, dates and numbers are in Spanish

### Requirement: Member locale resolution
For logged-in members, the locale SHALL be the member's saved preference, falling back to the board default.

#### Scenario: No preference set
- **WHEN** a member has no saved locale and the board default is `fr`
- **THEN** pages render in French

### Requirement: Guest locale resolution
For guests, the locale SHALL come from the `bp` preference cookie, falling back to the board default. `Accept-Language` SHALL NOT change server-rendered content.

#### Scenario: Guest with Spanish browser
- **WHEN** a guest without a `bp` cookie sends `Accept-Language: es`
- **THEN** the page renders in the board default locale, and a banner offers to switch to Spanish

#### Scenario: Guest switches locale
- **WHEN** the guest accepts the banner
- **THEN** the `bp` cookie is set with locale `es` and the page reloads in Spanish

### Requirement: Locale switcher
Every user-app page SHALL offer a language switcher. For members it saves the preference; for guests it sets the `bp` cookie.

#### Scenario: Member switches language
- **WHEN** a member picks French from the switcher
- **THEN** their preference is saved, and subsequent pages render in French on any device

### Requirement: Message formatting
Messages SHALL support ICU plural, select and number/date arguments. Dates, numbers and relative times SHALL be formatted for the active locale.

#### Scenario: Plural reply count
- **WHEN** a topic has 1 reply in `en`
- **THEN** it shows "1 reply", and with 5 replies it shows "5 replies"

### Requirement: Admin string overrides
Admins SHALL be able to override any interface string per locale from the staff app. Overrides SHALL take effect on the next page render and SHALL be revertible.

#### Scenario: Override a string
- **WHEN** an admin changes the `en` text of the "Reply" button to "Respond"
- **THEN** user-app pages show "Respond" after the change, and reverting restores "Reply"

### Requirement: Runtime catalog validation
Strings supplied at runtime (admin overrides, theme catalogs, plugin catalogs) SHALL be rejected if their ICU syntax is invalid or their placeholders do not match the base key. Missing keys SHALL fall back to English.

#### Scenario: Placeholder mismatch
- **WHEN** an admin saves an override missing the `{count}` placeholder used by the base string
- **THEN** the save is rejected with an error naming the missing placeholder

#### Scenario: Missing plugin key
- **WHEN** a plugin catalog lacks a French key
- **THEN** the English text is shown, and the staff app reports the plugin's French completeness below 100%

### Requirement: Catalog completeness in CI
The build SHALL fail if any shipped catalog key is missing in `en`, `es` or `fr`, or if a key is defined but unused.

#### Scenario: Missing translation
- **WHEN** a developer adds an `en` key without `es` and `fr`
- **THEN** `bun run check` fails, naming the key and the missing locales
