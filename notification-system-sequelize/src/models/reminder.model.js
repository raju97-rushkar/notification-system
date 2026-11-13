const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

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

const Reminder = sequelize.define(
  'Reminder',
  {
    // Primary key: a UUID generated automatically
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    userId: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },

    // DataTypes.DATE = "TIMESTAMP WITH TIME ZONE" in PostgreSQL (stored as UTC)
    dueAt: { type: DataTypes.DATE, allowNull: false },
    // User's timezone, e.g. "Asia/Kolkata". Only used to show local time.
    timezone: { type: DataTypes.STRING, allowNull: false, defaultValue: 'UTC' },

    // ENUM: the database only accepts these values
    status: {
      type: DataTypes.ENUM(...Object.values(STATUS)),
      allowNull: false,
      defaultValue: STATUS.PENDING,
    },

    // ----- used by the worker -----
    // When the worker should pick it up. Same as dueAt at the start,
    // moved to a later time when an attempt fails (retry).
    nextRunAt: { type: DataTypes.DATE, allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    maxAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
    lastError: { type: DataTypes.TEXT },
    // "Lock": which worker is processing it, and until when
    lockedBy: { type: DataTypes.STRING },
    lockedUntil: { type: DataTypes.DATE },
    processedAt: { type: DataTypes.DATE },

    // VIRTUAL = not stored in the database, calculated when read.
    // dueAt shown in the user's own timezone, e.g. "11/5/2026, 3:08:00 PM"
    dueAtLocal: {
      type: DataTypes.VIRTUAL,
      get() {
        const dueAt = this.getDataValue('dueAt');
        return dueAt ? dueAt.toLocaleString('en-US', { timeZone: this.getDataValue('timezone') }) : null;
      },
    },
  },
  {
    tableName: 'reminders',
    underscored: true, // JS "dueAt" <-> database column "due_at"
    timestamps: true, // adds createdAt / updatedAt

    // Index "fields" are database column names (snake_case)
    indexes: [
      // Worker: "pending reminders whose next_run_at has passed"
      { name: 'idx_reminders_status_next_run', fields: ['status', 'next_run_at'] },
      // Worker: "stuck reminders whose lock has expired"
      { name: 'idx_reminders_status_locked_until', fields: ['status', 'locked_until'] },
      // API: list a user's reminders, filter by status, sort by due date
      { name: 'idx_reminders_user_status_due', fields: ['user_id', 'status', 'due_at'] },
      // API: list a user's reminders, newest first
      { name: 'idx_reminders_user_created', fields: ['user_id', { name: 'created_at', order: 'DESC' }] },
    ],
  }
);

// Hide internal worker fields from API responses
Reminder.prototype.toJSON = function toJSON() {
  const values = { ...this.get() };
  delete values.lockedBy;
  delete values.lockedUntil;
  return values;
};

module.exports = { Reminder, STATUS };
