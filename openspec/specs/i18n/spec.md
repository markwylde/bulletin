# i18n Specification

## Purpose
Lets every person use Bulletin in English, Spanish or French. It also lets admins adjust
wording, and keeps cached pages deterministic per locale.

## Requirements

### Requirement: Supported locales
The user app, staff app, emails and push notifications SHALL be fully available in English (`en`), Spanish (`es`) and French (`fr`). The board default locale SHALL be configurable by admins.

#### Scenario: Spanish formatting
- **WHEN** any shipped message, date and number is formatted with locale `es`
- **THEN** the result is the Spanish text with Spanish date and number formats

### Requirement: Guest locale resolution
For guests, the locale SHALL come from the `bp` preference cookie, falling back to the board default. `Accept-Language` SHALL NOT change server-rendered content.

#### Scenario: Guest with Spanish browser
- **WHEN** locale resolution runs for a guest request without a `bp` cookie and with `Accept-Language: es`
- **THEN** the resolved locale is the board default, and `es` is returned only as a suggestion

#### Scenario: Guest cookie
- **WHEN** locale resolution runs for a guest request whose `bp` cookie has locale `es`
- **THEN** the resolved locale is `es`

### Requirement: Message formatting
Messages SHALL support ICU plural, select and number/date arguments. Dates, numbers and relative times SHALL be formatted for the active locale.

#### Scenario: Plural reply count
- **WHEN** a topic has 1 reply in `en`
- **THEN** it shows "1 reply", and with 5 replies it shows "5 replies"

### Requirement: Admin string overrides
Admins SHALL be able to override any interface string per locale from the staff app. Overrides SHALL take effect on the next page render and SHALL be revertible.

#### Scenario: Override a string
- **WHEN** an admin changes the `en` text of the "Reply" button to "Respond"
- **THEN** formatting the key returns "Respond" after the change, and reverting restores "Reply"

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

### Requirement: Member locale resolution
For logged-in members, the locale SHALL be the member's saved preference, falling back to the board default. Members SHALL be able to save their preference through the API.

#### Scenario: No preference set
- **WHEN** a member has no saved locale and the board default is `fr`
- **THEN** locale resolution for that member's requests returns French

#### Scenario: Preference follows the member
- **WHEN** a member saves `fr` as their preference on one device
- **THEN** locale resolution returns French for their requests on any device

### Requirement: Locale switcher
Every user-app page SHALL offer a language switcher. For members it SHALL save the preference; for guests it SHALL set the `bp` cookie.

#### Scenario: Member switches language
- **WHEN** a member picks French from the switcher
- **THEN** their preference is saved, and subsequent pages render in French on any device

### Requirement: Locale suggestion banner
When a guest's browser prefers a supported locale other than the one rendered, the page SHALL show a client-side banner offering to switch. Accepting SHALL set the `bp` cookie and reload.

#### Scenario: Guest accepts suggestion
- **WHEN** a guest without a `bp` cookie and with `Accept-Language: es` accepts the banner
- **THEN** the `bp` cookie is set with locale `es` and the page reloads in Spanish
