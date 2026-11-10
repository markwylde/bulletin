-- 0020: auto-promotion rules (ADR 0005).
-- Rules are ordered; the first rule whose criteria all pass moves the member's primary group.
-- Promotion history is the `member.promoted` outbox event (ADR 0011), not a second table.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS promotion_version bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS core.promotion_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  to_group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  position integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotion_rules_distinct_groups_check CHECK (from_group_id <> to_group_id),
  CONSTRAINT promotion_rules_criteria_object_check CHECK (jsonb_typeof(criteria) = 'object'),
  CONSTRAINT promotion_rules_criteria_numbers_check CHECK (
    NOT jsonb_path_exists(criteria, '$.* ? (@.type() != "number" || @ < 0)')
  )
);

CREATE INDEX IF NOT EXISTS promotion_rules_order_idx
  ON core.promotion_rules (enabled, position, id);

RESET ROLE;

GRANT SELECT ON core.promotion_rules TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.promotion_rules TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.promotion_rules_id_seq TO staff_api;

-- The promotion worker applies domain changes, so it emits outbox events (ADR 0011).
GRANT INSERT ON core.events TO workers;
