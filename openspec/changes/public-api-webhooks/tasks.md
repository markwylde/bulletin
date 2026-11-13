# Tasks

## 1. API foundation

- [x] 1.1 `/api/v1` router with key-only auth, CORS without credentials, and schema-driven validation and OpenAPI generation; tests for the cookie-ignored and OpenAPI scenarios
- [x] 1.2 API keys (migrations, hashing, prefix lookup, expiry, revocation, last used) and service members; tests for the shown-once and revoked scenarios
- [x] 1.3 Scopes and principal enforcement through `can()`, with tests for the scope and principal-limit scenarios
- [x] 1.4 Rate limiting with headers and 429, with an integration test
- [ ] 1.5 View-model contracts for the API docs page (CDN-cacheable) and the personal API keys page (`private, no-store`), registered with the harness

## 2. Endpoints

- [ ] 2.1 Read endpoints (forums, topics, posts, public member fields, search) using the same permission-filtered repositories, with permission-denial tests per endpoint
- [ ] 2.2 Write endpoints (create topic, reply, react, follow) using the same mutations as the apps, with tests including flood control and permission denial
- [ ] 2.3 API documentation page, verified to render the generated document

## 3. Webhooks

- [ ] 3.1 Webhook configuration (staff screen, SSRF check, principal, content fields), with tests for the private-target scenario and permission denial
- [ ] 3.2 Webhook subscriber in the relay (delivery-time visibility, minimal payloads, HMAC signing), with tests against `mocks/webhooks` for the staff-forum, default-payload and signature scenarios
- [ ] 3.3 Retries, delivery log, redelivery and auto-disable, with integration tests

## 4. Key management UI

- [ ] 4.1 Personal keys page (user app, gated by group setting) and integration keys (staff app); E2E at 360 and 1440

## 5. Strings and seed

- [ ] 5.1 Add en/es/fr strings for key and webhook management and API errors; verify completeness
- [ ] 5.2 Seed one integration key with a service member, one personal key and one webhook pointing at `mocks/webhooks`; verify deliveries appear in the mock after `docker compose up --watch`

## 6. Feature flag

- [ ] 6.1 Register `public_api`, `webhooks` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
