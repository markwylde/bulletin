# page-rendering Specification

## Purpose
Defines how user-app pages are produced from theme templates and typed view models with
interactive islands. Templates are customisable at runtime yet cannot execute code or inject
unsafe markup.

## Requirements

### Requirement: Pages render from theme templates
Every user-app page body SHALL be rendered from the active theme's templates using a typed view model for its route. Templates not overridden by a theme SHALL fall back to the parent theme.

#### Scenario: Template override
- **WHEN** an admin edits the forum-row template in a child theme
- **THEN** the forum list renders with the edited template, and other templates still come from the parent

### Requirement: Template changes without rebuild
Template edits saved in the staff app SHALL take effect on the next request, with no build or restart.

#### Scenario: Live edit
- **WHEN** a template is saved
- **THEN** the next page load uses the new template

### Requirement: Autoescaped output
All template output SHALL be HTML-escaped unless it comes from a view-model field typed as already-sanitised HTML. No template construct SHALL mark arbitrary text as safe.

#### Scenario: Escaped title
- **WHEN** a forum name contains `<script>alert(1)</script>`
- **THEN** the page shows it as text, and no script executes

### Requirement: Unsafe template markup rejected
Saving or installing a template containing scripts, event-handler attributes, `javascript:` or `data:` URLs, frames, objects, embeds, `base` tags, `meta` refresh, or forms posting to another origin SHALL be rejected with an error naming the problem.

#### Scenario: Event handler rejected
- **WHEN** an admin saves a template containing `<div onclick="…">`
- **THEN** the save fails with an error naming the `onclick` attribute and the line

### Requirement: Template resource limits
Template rendering SHALL be limited in time, memory, output size and include depth. A template exceeding a limit SHALL fall back to the parent theme's version and SHALL be reported to admins.

#### Scenario: Runaway loop
- **WHEN** a template's loop exceeds the render time limit
- **THEN** the page renders using the parent template, and the staff app shows the error

### Requirement: Interactive islands
Templates SHALL place interactive components only from a fixed registry, passing props validated against each component's schema. The component SHALL render on the server and become interactive in the browser.

#### Scenario: Island hydrates
- **WHEN** a page with a registered island loads
- **THEN** the island's server HTML is visible before scripts load, and it becomes interactive after hydration

#### Scenario: Invalid props
- **WHEN** a template passes props that fail the island's schema
- **THEN** the island is omitted, the page still renders, and the error is reported to admins

### Requirement: Required islands per route
Each route SHALL declare required islands. A theme SHALL NOT be activated if any template it overrides omits a required island.

#### Scenario: Missing reply editor
- **WHEN** a theme's topic template omits the reply editor island
- **THEN** activation is refused with an error naming the route and island

### Requirement: Hook points
Templates SHALL expose named hook points from a canonical registry. The default theme SHALL contain every registered hook point.

#### Scenario: Hook registry check
- **WHEN** a hook is added to the registry but missing from the default theme
- **THEN** the build fails, naming the hook

### Requirement: Content Security Policy
User-app pages SHALL allow scripts only from the board's own origin with per-response nonces.

#### Scenario: Injected inline script
- **WHEN** any inline script without the response nonce is present in a page
- **THEN** the browser blocks it
