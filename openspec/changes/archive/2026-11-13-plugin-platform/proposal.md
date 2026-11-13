# Proposal

## Why

You want a real plugin ecosystem: admins install plugins from our marketplace with one click,
and plugins can hook into everything without being able to break the core or read what they
shouldn't. ADR 0009 defines the model, and `plugin-sandbox-spike` (spike S2) has already proven the sandbox.

## What Changes

- Hardening the spike S2 prototype from `plugin-sandbox-spike` and completing the malicious-plugin suite.
- plugin-host supervisor and broker: per-plugin processes, capability enforcement, DB budgets, storage quota, egress allowlist and circuit breaker.
- Plugin SDK (versioned): hooks, core data APIs, jobs, settings, i18n and GDPR hooks.
- Lifecycle: install (signature, capability review), upgrade (quiesce, atomic migrate, activate), disable, uninstall, and failure recovery.
- Hook types: template fragments and overrides, view-model enrichers, filters and veto filters, event subscribers, content extensions, routes, jobs, permissions/settings registration, and iframe client apps with a postMessage bridge.
- Staff integration: plugin manager, settings via the form DSL, extension points on existing settings pages, fixed ACP page types, health and logs.
- Service principals (default Guests) with explicit elevated-access grants.
- Sample plugins in the seed and the marketplace mock.

## Capabilities

### New Capabilities
- `plugin-lifecycle`: discovering, installing, upgrading, disabling and removing plugins.
- `plugin-sandbox`: isolation and resource limits for plugin code and data.
- `plugin-hooks`: the ways plugins extend pages, content, behaviour and data.
- `plugin-admin-forms`: how plugins add settings and admin pages in the staff app.

### Modified Capabilities
- None.

## Impact

- `apps/plugin-host`, `packages/plugin-sdk`, user-api/staff-api broker endpoints, the template engine (hook resolution), the content pipeline (extensions), the event relay (plugin subscribers), the staff app, the marketplace mock, CI (malicious suite on both engines).
