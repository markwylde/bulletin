# warnings Specification

## Purpose
Lets moderators formally warn members, with points that escalate to automatic restrictions
and expire over time, in the style of IPB's warning system.

## Requirements

### Requirement: Warning reasons
Admins SHALL define warning reasons with a translated name, default points, default expiry, and whether moderators may change the points.

#### Scenario: Reason defaults
- **WHEN** a moderator picks the reason "Spam" (3 points, 30 days)
- **THEN** the warning form is pre-filled with 3 points and a 30-day expiry

### Requirement: Issue warnings
Moderators with the warn power SHALL warn a member about specific content or in general, with reason, points, expiry, a note to the member and a private staff note. The member SHALL be notified.

#### Scenario: Warn for post
- **WHEN** a moderator warns a member for a post
- **THEN** the member receives a notification with the reason and note, and the warning is linked to the post

### Requirement: Points and thresholds
A member's active points SHALL be the sum of unexpired, unrevoked warnings. Admins SHALL define thresholds that apply actions when reached: moderation queue for a duration, posting suspension for a duration, or a ban (timed or permanent).

#### Scenario: Suspension threshold
- **WHEN** a threshold at 10 points suspends posting for 7 days, and a warning brings a member to 10 points
- **THEN** the member cannot post for 7 days, and is told when posting resumes

### Requirement: Expiry and revocation
Warnings SHALL expire automatically, reducing active points. Moderators SHALL revoke warnings with a reason. Restrictions applied by thresholds SHALL NOT lift automatically when points drop, unless they were time-limited.

#### Scenario: Expiry
- **WHEN** a 30-day warning reaches its expiry
- **THEN** the member's active points decrease by its points

### Requirement: Acknowledgement
Admins SHALL be able to require members to acknowledge a warning before posting again.

#### Scenario: Must acknowledge
- **WHEN** a member with an unacknowledged warning tries to post
- **THEN** they are shown the warning and must acknowledge it first

### Requirement: Warning history
Members SHALL see their own warnings (without staff notes). Moderators SHALL see a member's full history, including staff notes.

#### Scenario: Member view
- **WHEN** a member opens their warnings page
- **THEN** they see reasons, points, expiry and member notes, but no staff notes
