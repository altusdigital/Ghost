const logging = require('@tryghost/logging');
const { createTransactionalMigration } = require('../../utils');

const settingsToRemove = ['mailgun_domain', 'mailgun_api_key', 'mailgun_base_url'];

module.exports = createTransactionalMigration(
  async function up(knex) {
    const existingSettings = await knex('settings').whereIn('key', settingsToRemove).pluck('key');

    if (existingSettings.length) {
      logging.info(`Deleting settings: ${existingSettings.join(', ')}`);
      await knex('settings').whereIn('key', existingSettings).del();
    }

    const missingSettings = settingsToRemove.filter((key) => !existingSettings.includes(key));
    if (missingSettings.length) {
      logging.warn(`Unable to delete missing settings: ${missingSettings.join(', ')}`);
    }
  },
  async function down() {
    logging.info('Not restoring removed Mailgun email settings');
  },
);
