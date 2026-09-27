const models = require('../../models');
const configService = require('../../../shared/config');
const settingsCache = require('../../../shared/settings-cache');
const CloudflareEmailClient = require('../lib/cloudflare-email-client');
const MailgunEmailSuppressionList = require('./mailgun-email-suppression-list');

const cloudflareClient = new CloudflareEmailClient({
  config: configService,
  settings: settingsCache,
});

module.exports = new MailgunEmailSuppressionList({
  Suppression: models.Suppression,
  apiClient: cloudflareClient,
});
