# 0016 — Public API, API keys and webhooks

**Status:** Accepted (revised after review)

## Decision
### Public API
- REST at `/api/v1` on user-api, with an OpenAPI document generated from route schemas at
  `/api/v1/openapi.json`.
- **Auth is API keys only** (`Authorization: Bearer blt_…`). Session cookies are **not**
  accepted on `/api/v1`, and API keys are not accepted anywhere else (ADR 0018).
- CORS on `/api/v1` is `*` **without credentials**.

### API keys
- Every key has a **principal**:
  - Personal keys are created by members (if their group allows) and act as that member.
  - Integration keys are created by admins and act as a **service member** that sits in normal
    groups, so its access is configured with the same permission matrix.
- Scopes (`read:forums`, `write:posts`, …) further restrict the principal; they never extend it.
- Keys are stored hashed (prefix plus SHA-256 with a server pepper) and shown once. They
  support last-used tracking, expiry and revocation.
- Rate limits per key and per IP use Postgres buckets (ADR 0003).

### Outbound webhooks
- Configured in the staff app: URL, subscribed events, secret, and a **principal**
  (a service member, as above).
- **Visibility**: an event is delivered only if `can(principal, read, resource)` is true **at
  delivery time** (ADR 0011). There is no "private" bypass flag.
- **Payload minimisation**: by default, events carry IDs, type, timestamps and public URLs.
  Including content fields is opt-in per webhook, and still gated by the principal.
  No Restricted (PII) data is ever included.
- Signed with HMAC-SHA256 over `timestamp.body` (`X-Bulletin-Signature`, `X-Bulletin-Timestamp`).
  Receivers should reject timestamps older than 5 minutes.
- Delivered by workers with retries and backoff, a per-webhook delivery log, manual
  redelivery, and auto-disable after sustained failure.
- SSRF protection: resolve-then-check, no private or link-local ranges (except to `mocks/webhooks`
  in dev), and no redirects.

## Consequences
- The API, webhooks and plugin events share one event catalog and schema source.
