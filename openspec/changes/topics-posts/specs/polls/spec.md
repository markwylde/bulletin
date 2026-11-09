# Spec Delta

## Purpose

Lets topic starters attach polls so members can vote on one or more questions.

## ADDED Requirements

### Requirement: Create a poll
A topic starter SHALL be able to attach one poll with 1–10 questions, each having 2–20 choices and being single- or multiple-choice. They SHALL set an optional close date, and whether results are visible before voting.

#### Scenario: Multi-question poll
- **WHEN** a member creates a topic with a poll of two questions, one of them multiple-choice
- **THEN** the topic shows both questions with the correct input types

### Requirement: Voting
Members with `vote` on the forum SHALL vote once per poll, before it closes. Guests SHALL NOT vote.

#### Scenario: Second vote rejected
- **WHEN** a member who already voted submits another vote
- **THEN** it is rejected

#### Scenario: Closed poll
- **WHEN** a poll's close date has passed
- **THEN** voting is disabled, and results are shown

### Requirement: Results visibility
If results are hidden before voting, a viewer SHALL see results only after voting, when the poll is closed, or if they are a moderator of the forum. Hidden counts SHALL NOT appear in shared or cached HTML; they SHALL be fetched from a private endpoint that checks these conditions per request.

#### Scenario: Hidden results
- **WHEN** a member who has not voted views a poll with hidden results
- **THEN** they see the choices but no counts

#### Scenario: Results after voting
- **WHEN** a member votes in a poll with hidden results
- **THEN** the results load from the private results endpoint without a page reload, and other viewers' cached poll HTML is unchanged

#### Scenario: No counts in cached HTML
- **WHEN** a guest requests a topic whose open poll hides results
- **THEN** the shared poll fragment contains no vote counts, and the results endpoint refuses the guest

### Requirement: Poll editing
The starter SHALL edit poll text within their edit window. Choices that have received votes SHALL NOT be removed, except by moderators, and only after confirmation.

#### Scenario: Remove voted choice
- **WHEN** the starter tries to remove a choice with votes
- **THEN** the change is rejected
