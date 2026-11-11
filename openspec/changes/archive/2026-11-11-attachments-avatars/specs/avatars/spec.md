# Spec Delta

## Purpose

Lets members personalise their identity with an avatar, with a consistent fallback for those
who have none.

## ADDED Requirements

### Requirement: Avatar upload
Members whose groups allow avatars SHALL upload an image, crop it to a square, and save it. Size and dimension limits SHALL come from group settings.

#### Scenario: Upload and crop
- **WHEN** a member uploads a photo and crops it
- **THEN** the cropped avatar appears next to their posts and on their profile

#### Scenario: Group disallows avatars
- **WHEN** a member whose groups do not allow avatars tries to upload one
- **THEN** the request is rejected with 403

### Requirement: Initials fallback
Members without an avatar SHALL be shown a generated avatar with their initials on a colour derived from their member ID. No third-party avatar service SHALL be used.

#### Scenario: No avatar
- **WHEN** a member named "Jane Doe" has no avatar
- **THEN** a "JD" avatar is shown with a stable colour

### Requirement: Avatars are public and cache-friendly
Avatar images SHALL be publicly readable at content-hashed URLs, so changing an avatar produces a new URL and old URLs can be cached long-term.

#### Scenario: Avatar change
- **WHEN** a member changes their avatar
- **THEN** pages rendered after the change reference the new URL

### Requirement: Staff removal
Staff with `members.edit` SHALL remove a member's avatar, and MAY block them from setting a new one for a period, with the action logged.

#### Scenario: Avatar removed
- **WHEN** a moderator removes an offensive avatar with a 30-day block
- **THEN** the member shows the initials avatar, and cannot upload a new one for 30 days
