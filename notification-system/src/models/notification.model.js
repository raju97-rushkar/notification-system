const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    reminderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reminder', required: true },
    userId: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    // The time the reminder was supposed to fire
    scheduledFor: { type: Date, required: true },
    // How late we were (for example, if the server was down)
    delayMs: { type: Number, default: 0 },
    readAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// ===== DUPLICATE PREVENTION =====
// Only ONE notification can exist per reminder. If two workers try to create it
// at the same time, MongoDB rejects the second one with error code 11000.
// This works even when our own code has a bug or a race condition.
notificationSchema.index({ reminderId: 1 }, { unique: true });

// API: list a user's notifications, newest first
notificationSchema.index({ userId: 1, createdAt: -1 });

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = { Notification };
