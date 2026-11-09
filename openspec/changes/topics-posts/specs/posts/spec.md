# Spec Delta

## Purpose

Covers replying to topics and the life of a post: editing, quoting, history and deletion.

## ADDED Requirements

### Requirement: Reply
Members with `reply` on a topic's forum SHALL post replies to unlocked topics. A reply SHALL appear at the end of the topic and update the topic's and forum's last-post information.

#### Scenario: Reply posted
- **WHEN** a member replies
- **THEN** they are taken to their post on the topic's last page, and the forum list shows them as last poster

### Requirement: Flood control
A member SHALL NOT post again within their effective flood-control interval.

#### Scenario: Too fast
- **WHEN** a member with 30 s flood control posts twice within 10 s
- **THEN** the second post is rejected, with the number of seconds to wait

### Requirement: Multi-quote
Members SHALL select several posts across pages of a topic for quoting, then insert all of them into the reply editor in one action.

#### Scenario: Quote three posts
- **WHEN** a member marks three posts for quoting and opens the reply editor
- **THEN** the editor contains three quotes in the order they were selected

### Requirement: Edit within the edit window
Authors SHALL edit their own posts within their group's edit window. Moderators with the edit power SHALL edit any post at any time. Edits SHALL show "Edited by X at time" when the edit happens more than 5 minutes after posting.

#### Scenario: Window expired
- **WHEN** an author with a 60-minute window edits a 2-hour-old post
- **THEN** the edit is rejected

### Requirement: Moderator edits redact quotes by default
When a moderator edits another member's post, the edit form SHALL offer "Redact earlier versions in quotes", checked by default, and SHALL apply content redaction to existing quotes when checked.

#### Scenario: Default redaction
- **WHEN** a moderator saves an edit to another member's post without changing the option
- **THEN** existing quotes of that post show the redaction notice

### Requirement: Edit history
Every edit SHALL keep the previous version. Moderators with the view-history power SHALL view and diff all versions. A board setting SHALL make history visible to everyone who can read the post.

#### Scenario: Moderator views history
- **WHEN** a moderator with view-history opens a post's history
- **THEN** they see every previous version with editor and time, and a diff between any two

#### Scenario: Member without permission
- **WHEN** a member requests a post's history while public history is off
- **THEN** the API responds 403

### Requirement: Soft delete and restore
Authors (if their group allows) and moderators SHALL soft-delete posts. Soft-deleted posts SHALL be hidden from viewers without see-deleted, and shown as collapsed "deleted" posts to those with it. Moderators with restore SHALL restore them.

#### Scenario: Soft-deleted hidden
- **WHEN** a post is soft-deleted
- **THEN** members without see-deleted no longer see it, and the topic's reply count decreases

#### Scenario: Restore
- **WHEN** a moderator restores a soft-deleted post
- **THEN** it reappears for everyone who can read the topic, and counts are restored

### Requirement: Hard delete
Moderators with hard-delete SHALL permanently delete posts and topics after a confirmation. Deleting a topic's first post SHALL require deleting the topic.

#### Scenario: Hard delete topic
- **WHEN** a moderator hard-deletes a topic
- **THEN** it and its posts no longer exist, and counts are updated

### Requirement: Post links
Every post SHALL have a permanent link that opens the topic at the page containing it, scrolled to the post.

#### Scenario: Permalink
- **WHEN** a member opens the permalink of post 30 in a 20-per-page topic
- **THEN** page 2 opens, scrolled to that post
