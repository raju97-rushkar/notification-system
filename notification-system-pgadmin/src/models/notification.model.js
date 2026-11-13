// The table is defined in src/db/schema.sql. This turns a row into an API object.
function toNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    reminderId: row.reminder_id,
    userId: row.user_id,
    title: row.title,
    message: row.message,
    scheduledFor: row.scheduled_for,
    // BIGINT columns come back from pg as text ("850"), so convert to a number
    delayMs: Number(row.delay_ms),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

module.exports = { toNotification };
