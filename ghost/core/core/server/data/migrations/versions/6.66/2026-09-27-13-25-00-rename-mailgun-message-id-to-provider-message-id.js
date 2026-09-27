const { combineNonTransactionalMigrations, createRenameColumnMigration } = require('../../utils');

module.exports = combineNonTransactionalMigrations(
  createRenameColumnMigration('email_batches', 'mailgun_message_id', 'provider_message_id', {
    algorithm: 'auto',
  }),
  createRenameColumnMigration(
    'automated_email_recipients',
    'mailgun_message_id',
    'provider_message_id',
    {
      algorithm: 'auto',
    },
  ),
);
