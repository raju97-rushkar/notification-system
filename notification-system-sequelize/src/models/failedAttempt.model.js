const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

// One row for every failed processing attempt (our "failure log").
const FailedAttempt = sequelize.define(
  'FailedAttempt',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    reminderId: { type: DataTypes.UUID, allowNull: false }, // foreign key, see models/index.js
    attempt: { type: DataTypes.INTEGER, allowNull: false },
    error: { type: DataTypes.TEXT, allowNull: false },
    workerId: { type: DataTypes.STRING },
    willRetry: { type: DataTypes.BOOLEAN, allowNull: false },
  },
  {
    tableName: 'failed_attempts',
    underscored: true,
    timestamps: true,
    updatedAt: false, // a log row is never updated, so only createdAt
    indexes: [
      // API: failures of one reminder
      { name: 'idx_failed_attempts_reminder', fields: ['reminder_id'] },
      // Worker: delete logs older than 30 days
      { name: 'idx_failed_attempts_created', fields: ['created_at'] },
    ],
  }
);

module.exports = { FailedAttempt };
