const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Notification = sequelize.define(
  'Notification',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },

    // Foreign key to reminders.id (the relationship is set up in models/index.js).
    // unique: true = DUPLICATE PREVENTION: only ONE notification per reminder,
    // enforced by PostgreSQL itself, even if two workers try at the same moment.
    reminderId: { type: DataTypes.UUID, allowNull: false, unique: true },

    userId: { type: DataTypes.STRING, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    message: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    // When it was supposed to fire
    scheduledFor: { type: DataTypes.DATE, allowNull: false },
    // How late it was created. BIGINT comes back from PostgreSQL as text,
    // so the getter turns it into a number.
    delayMs: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      get() {
        return Number(this.getDataValue('delayMs'));
      },
    },
    readAt: { type: DataTypes.DATE }, // null = unread
  },
  {
    tableName: 'notifications',
    underscored: true,
    timestamps: true,
    indexes: [
      // API: list a user's notifications, newest first
      { name: 'idx_notifications_user_created', fields: ['user_id', { name: 'created_at', order: 'DESC' }] },
    ],
  }
);

module.exports = { Notification };
