# Spec Delta

## Purpose

Ensures the board can be recovered to any point in the last 35 days, with database and file
storage brought back into agreement afterwards.

## ADDED Requirements

### Requirement: Point-in-time recovery
The production deployment guide SHALL configure continuous WAL archiving and nightly base backups, allowing restore to any point within 35 days.

#### Scenario: Restore drill
- **WHEN** the restore drill restores staging to a timestamp from yesterday
- **THEN** the board starts and shows content as of that time

### Requirement: File storage recovery
Object storage SHALL keep previous versions for 35 days, so objects deleted or overwritten in that window can be recovered.

#### Scenario: Recover deleted attachment
- **WHEN** an attachment object was deleted 3 days ago
- **THEN** its previous version can be restored from storage

### Requirement: Post-restore reconciliation
After a database restore, a reconciliation job SHALL remove stored objects not referenced by the database, and SHALL list database records whose objects are missing in the staff app.

#### Scenario: Missing object
- **WHEN** a restored database references an attachment whose object no longer exists
- **THEN** the staff app lists it as missing, and its download shows a clear error

### Requirement: Documented runbook
Restore procedures SHALL be documented step by step, and SHALL be exercised by a scripted drill at least quarterly in staging.

#### Scenario: Drill script
- **WHEN** an operator runs the drill script against staging
- **THEN** it performs the restore, runs reconciliation, runs smoke tests, and reports pass or fail
