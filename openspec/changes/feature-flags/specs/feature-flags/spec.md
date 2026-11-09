# Spec Delta

## Purpose

Lets staff turn features on or off and roll them out gradually to chosen groups or a
percentage of members, without deploying code.

## ADDED Requirements

### Requirement: Flag definition
Each flag SHALL have a unique key, description, owner, default value, an `affectsRender` marker, and an ordered list of rules. Flags declared in code SHALL appear in the staff app automatically, with their code default.

#### Scenario: New flag from code
- **WHEN** a deployment introduces a flag in code that has no stored definition
- **THEN** the staff app lists it with its code default and no rules

### Requirement: Group targeting
A rule SHALL be able to enable or disable a flag for members of any listed group.

#### Scenario: Moderators only
- **WHEN** a flag has a rule enabling it for the Moderators group
- **THEN** it is on for a member in Moderators and off for a member who is not

### Requirement: Percentage rollout
A rule SHALL be able to enable a flag for a percentage of members, using a stable assignment so that the same member always gets the same result for the same flag and percentage.

#### Scenario: Stable assignment
- **WHEN** a flag is at 20% and a member reloads pages repeatedly
- **THEN** the member gets the same value each time

#### Scenario: Increasing percentage keeps existing members
- **WHEN** a flag goes from 20% to 50%
- **THEN** every member who had it on at 20% still has it on

### Requirement: Guests and render-affecting flags
For flags marked `affectsRender`, guests SHALL be evaluated by group targeting only (as the Guests group). Percentage rules SHALL NOT apply to them.

#### Scenario: Guest with percentage flag
- **WHEN** a render-affecting flag is on for 50% of members and has no Guests rule
- **THEN** all guests get the flag's default value

### Requirement: Server-side enforcement
When a flag gating a feature is off for a requester, the feature's API endpoints SHALL reject the request as not found, not only hide the UI.

#### Scenario: Flagged endpoint
- **WHEN** a member with the flag off calls the flagged endpoint directly
- **THEN** the API responds 404

### Requirement: Flag changes take effect promptly
Flag changes SHALL apply to new requests within 1 second, with no restart. Changes SHALL be recorded in the admin log.

#### Scenario: Toggle flag
- **WHEN** an admin turns a flag on
- **THEN** the next page load reflects it, and the admin log records the change with before and after rules

### Requirement: Flag management screen
Staff with `acp.flags` SHALL see all flags with key, description, owner, current rules, and the age of the flag, and SHALL be able to edit rules.

#### Scenario: Stale flag visible
- **WHEN** a flag has been 100% on for over 90 days
- **THEN** the list highlights it as ready for removal
