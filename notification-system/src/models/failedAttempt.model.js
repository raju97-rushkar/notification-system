const mongoose = require('mongoose');

// One document for every failed processing attempt (our "failure log").
// Kept in a separate collection so the reminder document doesn't keep growing.
const failedAttemptSchema = new mongoose.Schema(
  {
    reminderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reminder', required: true },
    attempt: { type: Number, required: true },
    error: { type: String, required: true },
    workerId: { type: String },
    willRetry: { type: Boolean, required: true },
  },
  { timestamps: true, versionKey: false }
);

// API: show failures of one reminder
failedAttemptSchema.index({ reminderId: 1 });
// TTL index: MongoDB automatically deletes failure logs older than 30 days
failedAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

const FailedAttempt = mongoose.model('FailedAttempt', failedAttemptSchema);

module.exports = { FailedAttempt };
