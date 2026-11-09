# Spec Delta

## ADDED Requirements

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
