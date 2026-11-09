# Spec Delta

## ADDED Requirements

### Requirement: Display-name step page
A logged-in member without a display name SHALL be redirected to a themed display-name step page on any page navigation, and SHALL return to the requested page after choosing a valid name.

#### Scenario: New member redirected
- **WHEN** a new member without a display name navigates to any page
- **THEN** they are redirected to the display-name step, and after saving a valid name they land on the page they asked for
