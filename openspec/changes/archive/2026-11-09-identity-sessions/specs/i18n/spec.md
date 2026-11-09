# Spec Delta

## ADDED Requirements

### Requirement: Member locale resolution
For logged-in members, the locale SHALL be the member's saved preference, falling back to the board default. Members SHALL be able to save their preference through the API.

#### Scenario: No preference set
- **WHEN** a member has no saved locale and the board default is `fr`
- **THEN** locale resolution for that member's requests returns French

#### Scenario: Preference follows the member
- **WHEN** a member saves `fr` as their preference on one device
- **THEN** locale resolution returns French for their requests on any device
