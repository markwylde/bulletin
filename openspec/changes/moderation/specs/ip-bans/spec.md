# Spec Delta

## Purpose

Lets staff remove abusive members and block abusive networks, while treating IP data as
restricted personal data.

## ADDED Requirements

### Requirement: Member bans
Staff with `members.ban` SHALL ban members permanently or until a date, with a reason. A banned member SHALL be placed in the Banned group, see a ban notice with the reason and end date, and be unable to post, react, message or change their profile.

#### Scenario: Timed ban ends
- **WHEN** a 7-day ban expires
- **THEN** the member is restored to their previous groups automatically

### Requirement: IP and range bans
Staff with `bans.ip` SHALL ban single IPs or CIDR ranges with a reason and expiry (default 1 year). Requests from banned addresses SHALL be refused for logging in and posting, and SHALL see a generic block message.

#### Scenario: CIDR ban
- **WHEN** staff ban `203.0.113.0/24`
- **THEN** a request from `203.0.113.77` cannot log in or post

#### Scenario: Ban expiry
- **WHEN** an IP ban's expiry passes
- **THEN** requests from that address are no longer blocked

### Requirement: Audited IP lookups
Moderators with the view-IPs power for a forum SHALL see the IP address of posts in that forum, and SHALL look up other members who posted from the same IP. Each lookup SHALL be recorded before the data is shown, and SHALL require recent authentication.

#### Scenario: Lookup audited
- **WHEN** a moderator views a post's IP
- **THEN** an audit entry with the moderator, the post and the purpose exists before the IP is displayed

#### Scenario: No power
- **WHEN** a moderator without view-IPs requests a post's IP
- **THEN** the request is denied, and nothing is returned

### Requirement: IP data retention
Post and login IP records SHALL be deleted after the configured retention period (default 90 days). Lookups for older content SHALL show that the data has expired.

#### Scenario: Expired IP
- **WHEN** a moderator views the IP of a 120-day-old post with 90-day retention
- **THEN** they see "IP data expired"
