-- Database tables. This file runs on every app start.
-- "IF NOT EXISTS" makes it safe to run many times: existing tables/data are not touched.

-- ===================== reminders =====================
CREATE TABLE IF NOT EXISTS reminders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  title         TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',

  -- TIMESTAMPTZ always stores the moment in UTC
  due_at        TIMESTAMPTZ NOT NULL,
  -- user's timezone, e.g. 'Asia/Kolkata' (only used to show local time)
  timezone      TEXT NOT NULL DEFAULT 'UTC',

  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),

  -- ----- used by the worker -----
  next_run_at   TIMESTAMPTZ NOT NULL,          -- when the worker should pick it up
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  last_error    TEXT,
  locked_by     TEXT,                          -- which worker is processing it
  locked_until  TIMESTAMPTZ,                   -- lock expires at this time
  processed_at  TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker: "pending reminders whose next_run_at has passed"
CREATE INDEX IF NOT EXISTS idx_reminders_status_next_run ON reminders (status, next_run_at);
-- Worker: "stuck reminders whose lock has expired"
CREATE INDEX IF NOT EXISTS idx_reminders_status_locked_until ON reminders (status, locked_until);
-- API: list a user's reminders, filter by status, sort by due date
CREATE INDEX IF NOT EXISTS idx_reminders_user_status_due ON reminders (user_id, status, due_at);
-- API: list a user's reminders, newest first
CREATE INDEX IF NOT EXISTS idx_reminders_user_created ON reminders (user_id, created_at DESC);


-- ===================== notifications =====================
CREATE TABLE IF NOT EXISTS notifications (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE = DUPLICATE PREVENTION: only one notification per reminder,
  -- enforced by PostgreSQL itself.
  reminder_id    UUID NOT NULL UNIQUE REFERENCES reminders(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL,
  title          TEXT NOT NULL,
  message        TEXT NOT NULL DEFAULT '',
  scheduled_for  TIMESTAMPTZ NOT NULL,         -- when it was supposed to fire
  delay_ms       BIGINT NOT NULL DEFAULT 0,    -- how late it was created
  read_at        TIMESTAMPTZ,                  -- NULL = unread
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API: list a user's notifications, newest first
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);


-- ===================== failed_attempts =====================
-- One row for every failed processing attempt (our "failure log").
CREATE TABLE IF NOT EXISTS failed_attempts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id  UUID NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  attempt      INTEGER NOT NULL,
  error        TEXT NOT NULL,
  worker_id    TEXT,
  will_retry   BOOLEAN NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API: failures of one reminder
CREATE INDEX IF NOT EXISTS idx_failed_attempts_reminder ON failed_attempts (reminder_id);
-- Worker: delete logs older than 30 days
CREATE INDEX IF NOT EXISTS idx_failed_attempts_created ON failed_attempts (created_at);
