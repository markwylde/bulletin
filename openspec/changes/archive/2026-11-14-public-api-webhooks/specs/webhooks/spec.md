# Spec Delta

## Purpose

Notifies external systems about board events reliably and securely, sending only what the
configured principal may see.

## ADDED Requirements

### Requirement: Webhook configuration
Staff with `acp.webhooks` SHALL create webhooks with a target URL, subscribed event types, a secret, a principal (service member), and optional content fields. Target URLs SHALL NOT resolve to private or internal addresses in production.

#### Scenario: Private target rejected
- **WHEN** an admin configures a webhook to `http://192.168.1.10/hook` in production
- **THEN** the configuration is rejected

### Requirement: Visibility at delivery
A webhook SHALL receive an event only if its principal can read the referenced content at delivery time.

#### Scenario: Staff forum event
- **WHEN** a topic is created in a staff-only forum and the webhook's principal cannot read it
- **THEN** no delivery is made for that event

### Requirement: Minimal payloads
Payloads SHALL contain the event type, IDs, timestamps and public URLs by default. Content fields SHALL be included only if enabled for the webhook. Restricted personal data SHALL never be included.

#### Scenario: Default payload
- **WHEN** a `post.created` webhook without content fields fires
- **THEN** the payload has IDs and URL, but no post text

### Requirement: Signed deliveries
Each delivery SHALL be signed with HMAC-SHA256 over the timestamp and body, sent in signature and timestamp headers.

#### Scenario: Verify signature
- **WHEN** the receiver recomputes the HMAC with the shared secret
- **THEN** it matches the signature header

### Requirement: Retries and delivery log
Failed deliveries SHALL be retried with exponential backoff for up to 24 hours. Each attempt SHALL be logged with status and response time. Staff SHALL redeliver any past delivery. A webhook failing continuously for 24 hours SHALL be disabled, and admins notified.

#### Scenario: Redeliver
- **WHEN** an admin redelivers a failed delivery
- **THEN** a new attempt is made with a fresh timestamp and signature
