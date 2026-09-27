const { addSetting, combineTransactionalMigrations } = require('../../utils');

module.exports = combineTransactionalMigrations(
  addSetting({
    key: 'cloudflare_account_id',
    value: null,
    type: 'string',
    group: 'email',
  }),
  addSetting({
    key: 'cloudflare_api_token',
    value: null,
    type: 'string',
    group: 'email',
  }),
  addSetting({
    key: 'cloudflare_zone_id',
    value: null,
    type: 'string',
    group: 'email',
  }),
  addSetting({
    key: 'cloudflare_sending_domain',
    value: null,
    type: 'string',
    group: 'email',
  }),
);
