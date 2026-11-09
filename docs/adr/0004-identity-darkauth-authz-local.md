# 0004 — Identity via DarkAuth, authorisation in Bulletin

**Status:** Accepted (revised after review)

## Context
Registration, login and account security belong to DarkAuth. Everything about what a person
may do in the forum belongs to Bulletin. Atlas (`../atlas`) shows the local pattern with
`ghcr.io/puzed/darkauth-mock`.

## Decision
- DarkAuth is the only identity provider. Login flow, sessions, cookies, CSRF and origins are
  specified in **ADR 0018**.
- **Identity mapping**: `pii.identities(member_id, issuer, sub, email, idp_name)` maps a
  DarkAuth identity to `core.members.id`. `core.members` holds **no** issuer, sub or email; it
  uses only the internal `member_id`. The lookup `(issuer, sub) → member_id` is done by a
  `SECURITY DEFINER` function (ADR 0012).
- First login creates the member, assigns the default groups, and asks for a forum
  **display name**. The display name is Bulletin's own, unique (case-insensitive,
  confusable-normalised), and changeable per group limits, with history in
  `core.member_name_history`.
- **DarkAuth roles/permissions are ignored** for authorisation, with one bootstrap exception:
  env `BULLETIN_BOOTSTRAP_ADMINS` lists `issuer|sub` pairs added to Administrators on first login.
- Staff app access is a Bulletin group permission (`acp.access` plus granular ACP permissions),
  checked by staff-api on every request.
- Guests are a real group (`Guests`) so all permission checks are uniform.
- Banning is Bulletin-side. A banned member can still authenticate but is placed in Banned.
- `darkauth-mock.yaml` seeds profiles that match seeded members: admin, super-mod,
  forum-mod, member-specific mod, regular members, new member (in mod queue), banned member,
  warned member, and es/fr-locale members.

## Consequences
- Bulletin never stores passwords or handles registration/reset/MFA.
