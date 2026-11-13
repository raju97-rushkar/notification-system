// The table itself is defined in src/db/schema.sql.
// This file has the list of statuses and turns a database row into an API object.

// All possible states of a reminder:
//   pending    -> waiting for its time (or waiting for a retry)
//   processing -> a worker is working on it right now
//   completed  -> notification created
//   failed     -> all attempts failed
//   cancelled  -> cancelled by the user
const STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Database columns use snake_case (due_at), the API uses camelCase (dueAt).
// Internal worker columns (locked_by, locked_until) are not returned.
function toReminder(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    message: row.message,
    dueAt: row.due_at,
    timezone: row.timezone,
    // dueAt shown in the user's own timezone, e.g. "11/5/2026, 3:08:00 PM"
    dueAtLocal: row.due_at.toLocaleString('en-US', { timeZone: row.timezone }),
    status: row.status,
    nextRunAt: row.next_run_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { STATUS, toReminder };
