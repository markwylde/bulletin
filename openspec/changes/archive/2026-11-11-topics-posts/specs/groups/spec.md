# Spec Delta

## ADDED Requirements

### Requirement: Promotion by approved posts
Promotion rules SHALL be able to use the member's approved post count, evaluated after each approved post.

#### Scenario: Promotion on post count
- **WHEN** a rule promotes Members to Regulars at 100 approved posts, and a member's 100th post is approved
- **THEN** their primary group becomes Regulars exactly once
