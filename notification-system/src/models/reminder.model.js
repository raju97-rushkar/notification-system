const mongoose = require('mongoose');

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

const reminderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, default: '' },

    // When the reminder should fire. MongoDB always stores dates in UTC.
    dueAt: { type: Date, required: true },
    // User's timezone, e.g. "Asia/Kolkata". Only used to show local time.
    timezone: { type: String, default: 'UTC' },

    status: { type: String, enum: Object.values(STATUS), default: STATUS.PENDING },

    // ----- used by the worker -----
    // When the worker should pick it up. Same as dueAt at the start,
    // moved to a later time when an attempt fails (retry).
    nextRunAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    lastError: { type: String, default: null },
    // "Lock": which worker is processing it, and until when.
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  {
    timestamps: true, // adds createdAt and updatedAt
    versionKey: false,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        // Internal worker fields are hidden from API responses
        delete ret.lockedBy;
        delete ret.lockedUntil;
        delete ret.id;
        return ret;
      },
    },
  }
);

// Extra field in API responses: dueAt shown in the user's own timezone.
reminderSchema.virtual('dueAtLocal').get(function () {
  return this.dueAt.toLocaleString('en-US', { timeZone: this.timezone });
});

// ---------------- Indexes ----------------
// Worker: "find pending reminders whose nextRunAt has passed"
reminderSchema.index({ status: 1, nextRunAt: 1 });
// Worker: "find stuck reminders whose lock has expired"
reminderSchema.index({ status: 1, lockedUntil: 1 });
// API: list a user's reminders, filter by status, sort by dueAt
reminderSchema.index({ userId: 1, status: 1, dueAt: 1 });
// API: list a user's reminders, newest first (default sort)
reminderSchema.index({ userId: 1, createdAt: -1 });

const Reminder = mongoose.model('Reminder', reminderSchema);

module.exports = { Reminder, STATUS };
