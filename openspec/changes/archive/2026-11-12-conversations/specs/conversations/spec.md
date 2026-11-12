# Spec Delta

## Purpose

Lets members talk privately in conversations with one or more other members, with controls
that keep them safe from unwanted contact.

## ADDED Requirements

### Requirement: Start a conversation
Members whose groups allow PMs SHALL start a conversation with a title, a first message and up to their group's maximum number of recipients. Recipients who cannot use PMs, or who ignore the starter, SHALL be refused with a generic error.

#### Scenario: Group conversation
- **WHEN** a member starts a conversation with 3 recipients and a limit of 5
- **THEN** all 4 participants see it in their inbox

#### Scenario: Too many recipients
- **WHEN** a member with a limit of 5 adds 6 recipients
- **THEN** the conversation is rejected, naming the limit

### Requirement: Privacy of conversations
Only current participants SHALL read a conversation. Staff SHALL NOT browse conversations, except for messages reported to them (see moderation).

#### Scenario: Non-participant
- **WHEN** a member who is not a participant requests a conversation by ID
- **THEN** the response is 404

#### Scenario: Admin without report
- **WHEN** an administrator requests a conversation they are not part of and that has no report
- **THEN** the response is 404

### Requirement: Conversations are never shared-cached
Conversation pages and responses SHALL be marked private and not storable, and SHALL never be served from any shared cache.

#### Scenario: Response headers
- **WHEN** a participant loads a conversation
- **THEN** the response has `Cache-Control: private, no-store`

### Requirement: Replies and participants
Participants SHALL reply. The starter SHALL invite more participants (within the limit) and remove participants. Any participant SHALL leave. Leaving (or being removed) SHALL end all access to the conversation, including earlier messages; there is no separate "delete for me". A participant who left with "block re-invites" SHALL NOT be re-invited.

#### Scenario: Leave removes access
- **WHEN** a participant leaves a conversation
- **THEN** it disappears from all their folders, and requesting it by ID returns 404

#### Scenario: Leave and block
- **WHEN** a participant leaves with "block re-invites"
- **THEN** the starter cannot add them back

#### Scenario: New participant sees history
- **WHEN** the starter invites a new participant
- **THEN** that participant sees the full history from the start

### Requirement: Inbox and folders
Members SHALL see their conversations in Inbox, Sent and Archive, ordered by latest message, with unread indicators. They SHALL archive and unarchive conversations, and search their own conversations by title and content.

#### Scenario: Archive
- **WHEN** a member archives a conversation and a new reply arrives
- **THEN** it moves back to the Inbox as unread

### Requirement: Quotas and rate limits
Group settings SHALL limit how many conversations a member can keep and how many they can start per day. The quota counts conversations the member still participates in. At the quota, starting new conversations SHALL be blocked until they leave some, while receiving SHALL continue.

#### Scenario: Over quota
- **WHEN** a member at their conversation quota tries to start a new conversation
- **THEN** it is rejected with a link to manage their conversations

### Requirement: Restricted senders
Banned members and members whose groups disallow PMs SHALL NOT start conversations or reply.

#### Scenario: Suspended member
- **WHEN** a member who is suspended from posting tries to reply in a conversation
- **THEN** the reply is rejected

### Requirement: Notifications and live updates
New conversations and replies SHALL notify participants according to their preferences, and SHALL appear live in open conversations.

#### Scenario: Live reply
- **WHEN** a participant has a conversation open and another participant replies
- **THEN** the reply appears without a reload

### Requirement: Permanent removal
A conversation SHALL be permanently removed, with its messages and attachments, once no participants remain. Messages under an open report SHALL be kept until the report closes, then removed.

#### Scenario: Last participant leaves
- **WHEN** the last remaining participant leaves a conversation
- **THEN** its messages and attachments are permanently deleted

#### Scenario: Open report holds messages
- **WHEN** the last participant leaves a conversation with an open report on one of its messages
- **THEN** only the reported message and its report context are kept, and they are deleted when the report closes
