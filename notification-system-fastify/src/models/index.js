// Loads all models and sets up the RELATIONSHIPS between them.
const { Reminder, STATUS } = require('./reminder.model');
const { Notification } = require('./notification.model');
const { FailedAttempt } = require('./failedAttempt.model');

// One reminder -> at most ONE notification (1:1)
// Creates the foreign key notifications.reminder_id -> reminders.id
Reminder.hasOne(Notification, { foreignKey: 'reminderId', as: 'notification', onDelete: 'CASCADE' });
Notification.belongsTo(Reminder, { foreignKey: 'reminderId', as: 'reminder' });

// One reminder -> MANY failed attempts (1:N)
// Creates the foreign key failed_attempts.reminder_id -> reminders.id
Reminder.hasMany(FailedAttempt, { foreignKey: 'reminderId', as: 'failedAttempts', onDelete: 'CASCADE' });
FailedAttempt.belongsTo(Reminder, { foreignKey: 'reminderId', as: 'reminder' });

// onDelete: 'CASCADE' -> if a reminder row is deleted, its notification and
// failure logs are deleted too, so there are never "orphan" rows.

module.exports = { Reminder, Notification, FailedAttempt, STATUS };
