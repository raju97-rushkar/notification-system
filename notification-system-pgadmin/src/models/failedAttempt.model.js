// The table is defined in src/db/schema.sql. This turns a row into an API object.
function toFailedAttempt(row) {
  return {
    id: row.id,
    reminderId: row.reminder_id,
    attempt: row.attempt,
    error: row.error,
    workerId: row.worker_id,
    willRetry: row.will_retry,
    createdAt: row.created_at,
  };
}

module.exports = { toFailedAttempt };
