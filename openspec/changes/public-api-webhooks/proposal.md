# Proposal

## Why

You want third-party integrations through API keys and outbound webhooks. ADR 0016 defines
key principals, scopes, delivery-time visibility and payload minimisation.

## What Changes

- Public REST API `/api/v1` with a generated OpenAPI document: forums, topics, posts, members (public fields), search, and writes for posting, reacting and following.
- API keys: personal (member) and integration (service member), with scopes, hashing, expiry, revocation and last-used tracking.
- Rate limits per key and per IP.
- Outbound webhooks: configuration, event selection, principal, opt-in content fields, HMAC signing, retries, delivery log, redelivery and auto-disable.
- API documentation page rendered from the OpenAPI document.

## Capabilities

### New Capabilities
- `public-api`: the versioned third-party API and its authentication.
- `webhooks`: outbound event notifications to external systems.

### Modified Capabilities
- None.

## Impact

- user-api (`/api/v1`), staff-app (keys, webhooks), user-app (personal keys), workers (deliveries), the event relay (webhook subscribers), the webhooks mock.
