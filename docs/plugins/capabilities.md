# Capabilities

Every capability is reviewed in plain language before an install, with elevated data access
and egress hosts highlighted. The install cannot start without approval and recent step-up
authentication.

| Capability | Grants |
|---|---|
| `db` | DML in the plugin's own schema through the broker allowlist |
| `core.read` | Read core APIs as the viewer ∩ service principal |
| `core.write` | Write core APIs as the viewer ∩ service principal |
| `events` | Subscribe to domain events |
| `jobs` | Enqueue and run plugin jobs |
| `kv` | Store key/value data in its schema |
| `cache.invalidate` | Bump only `plugin:<id>:*` tags |
| `egress` | HTTP through the broker to approved, manifest-declared hosts; declaring hosts without this capability is rejected at install |
| `template` | Inject template fragments/overrides |
| `enricher` | Add declared view-model fields |
| `filter` | Transform content on the write path |
| `veto` | Veto writes (with admin fail-open/fail-closed choice) |
| `route` | Serve themed/API routes |
| `client` | Provide a sandboxed iframe app |
| `settings` | Declare settings forms and extension sections |
| `pii` | Access personal data through audited APIs |
| `gdpr` | Handle export/erasure requests |

The service principal defaults to **Guests**. An elevated grant names the forums the plugin may
read and shows: “this plugin can read X and may display or repost it to anyone”; the grant is
written to the admin log. Background access can never exceed that grant, and viewer-context
calls are intersected with both the viewer and the service principal.
