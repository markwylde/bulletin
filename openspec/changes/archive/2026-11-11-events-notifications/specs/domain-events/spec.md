# Spec Delta

## ADDED Requirements

### Requirement: Dead letters visible
Deliveries that exhaust retries SHALL be listed in the staff app with error details, and staff SHALL be able to retry them.

#### Scenario: Retry dead letter
- **WHEN** an admin retries a dead-lettered delivery after fixing the cause
- **THEN** it is delivered and removed from the dead-letter list
