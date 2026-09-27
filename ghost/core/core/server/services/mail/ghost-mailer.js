// # Mail
// Handles sending email for Ghost
const _ = require('lodash');
const config = require('../../../shared/config');
const logging = require('@tryghost/logging');
const errors = require('@tryghost/errors');
const tpl = require('@tryghost/tpl');
const settingsCache = require('../../../shared/settings-cache');
const urlUtils = require('../../../shared/url-utils').default;
const emailAddress = require('../email-address');
const messages = {
  title: 'Ghost at {domain}',
  checkEmailConfigInstructions: 'Please see {url} for instructions on configuring email.',
  failedSendingEmailError: 'Failed to send email.',
  incompleteMessageDataError: 'Incomplete message data.',
  reason: ' Reason: {reason}.',
  messageSent: 'Message sent. Double check inbox and spam folder!',
};
const emailAddressParser = require('../email-address/email-address-parser');

function getDomain() {
  const domain = urlUtils
    .urlFor('home', true)
    .match(new RegExp('^https?://([^/:?#]+)(?:[/:?#]|$)', 'i'));
  return domain && domain[1];
}

/**
 * @param {string} requestedFromAddress
 * @param {string} requestedReplyToAddress
 * @returns {{from: string, replyTo?: string|null}}
 */
function getFromAddress(requestedFromAddress, requestedReplyToAddress) {
  if (!requestedFromAddress) {
    // Use the default config
    requestedFromAddress = emailAddress.service.defaultFromEmail;
  }

  // Clean up email addresses (checks whether sending is allowed + email address is valid)
  const addresses = emailAddress.service.getAddressFromString(
    requestedFromAddress,
    requestedReplyToAddress,
  );

  // fill in missing name if not set
  const defaultSiteTitle = settingsCache.get('title')
    ? settingsCache.get('title')
    : tpl(messages.title, { domain: getDomain() });
  if (!addresses.from.name) {
    addresses.from.name = defaultSiteTitle;
  }

  return {
    from: emailAddressParser.stringify(addresses.from),
    replyTo: addresses.replyTo ? emailAddressParser.stringify(addresses.replyTo) : null,
  };
}

/**
 * Decorates incoming message object with nodemailer compatible fields.
 * For nodemailer 0.7.1 reference see - https://github.com/nodemailer/nodemailer/tree/da2f1d278f91b4262e940c0b37638e7027184b1d#e-mail-message-fields
 * @param {Object} message
 * @param {boolean} [message.forceTextContent] - force text content
 * @param {string} [message.from] - sender email address
 * @param {string} [message.replyTo]
 * @returns {Object}
 */
function createMessage(message) {
  const encoding = 'base64';
  const generateTextFromHTML = !message.forceTextContent;
  const cleanMessage = { ...message };
  delete cleanMessage.tags;
  delete cleanMessage.forceTextContent;
  delete cleanMessage.trackOpens;
  delete cleanMessage.disableTracking;

  const addresses = getFromAddress(message.from, message.replyTo);

  return {
    ...cleanMessage,
    ...addresses,
    generateTextFromHTML,
    encoding,
    headers: {
      Sender: addresses.from,
      ...message.headers,
    },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.message]
 * @param {Error} [options.err]
 * @param {boolean} [options.ignoreDefaultMessage]
 * @return {errors.EmailError}
 */
function createMailError({ message, err, ignoreDefaultMessage } = { message: '' }) {
  const helpMessage = tpl(messages.checkEmailConfigInstructions, {
    url: 'https://docs.ghost.org/config/#mail',
  });
  const defaultErrorMessage = tpl(messages.failedSendingEmailError);

  const fullErrorMessage = defaultErrorMessage + message;
  const statusCode = err && err.name === 'RecipientError' ? 400 : 500;
  return new errors.EmailError({
    message: ignoreDefaultMessage ? message : fullErrorMessage,
    err: err,
    statusCode,
    help: helpMessage,
  });
}

module.exports = class GhostMailer {
  constructor() {
    const nodemailer = require('@tryghost/nodemailer');

    let transport = (config.get('mail') && config.get('mail').transport) || 'direct';
    transport = transport.toLowerCase();
    if (transport === 'mailgun') {
      logging.warn(
        '[MAIL] The Mailgun transport has been removed. Configure Cloudflare Email, or choose another mail transport.',
      );
      transport = 'direct';
    }

    // nodemailer mutates the options passed to createTransport
    const options = (config.get('mail') && _.clone(config.get('mail').options)) || {};

    this.state = {
      usingDirect: transport === 'direct',
    };
    this.transport = nodemailer(transport, options);
  }

  /**
   *
   * @param {Object} message
   * @param {string} message.subject - email subject
   * @param {string} message.html - email content
   * @param {string} message.to - email recipient address
   * @param {string} [message.replyTo]
   * @param {string} [message.from] - sender email address
   * @param {string} [message.text] - text version of this message
   * @param {string[]} [message.tags] - ignored; Cloudflare does not take Mailgun tags
   * @param {boolean} [message.trackOpens] - ignored; newsletter opens use the Ghost pixel
   * @param {boolean} [message.disableTracking] - ignored; Cloudflare sends are not Mailgun-tracked
   * @param {Record<string, string>} [message.headers] - optional additional email headers (merged with defaults)
   * @param {boolean} [message.forceTextContent] - maps to generateTextFromHTML nodemailer option
   * which is: "if set to true uses HTML to generate plain text body part from the HTML if the text is not defined"
   * (ref: https://github.com/nodemailer/nodemailer/tree/da2f1d278f91b4262e940c0b37638e7027184b1d#e-mail-message-fields)
   * @returns {Promise<any>}
   */
  async send(message) {
    if (!(message && message.subject && message.html && message.to)) {
      throw createMailError({
        message: tpl(messages.incompleteMessageDataError),
        ignoreDefaultMessage: true,
      });
    }

    const messageToSend = createMessage(message);
    const CloudflareEmailClient = require('../lib/cloudflare-email-client');
    const cloudflareClient = new CloudflareEmailClient({ config, settings: settingsCache });
    if (cloudflareClient.isConfigured()) {
      return cloudflareClient.sendTransactional({
        to: messageToSend.to,
        subject: messageToSend.subject,
        html: messageToSend.html,
        text: messageToSend.text,
        from: messageToSend.from,
        replyTo: messageToSend.replyTo,
        headers: message.headers,
      });
    }

    const response = await this.sendMail(messageToSend);

    if (this.state.usingDirect) {
      return this.handleDirectTransportResponse(response);
    }

    return response;
  }

  async sendMail(message) {
    try {
      return await this.transport.sendMail(message);
    } catch (err) {
      throw createMailError({
        message: tpl(messages.reason, { reason: err.message || err }),
        err,
      });
    }
  }

  handleDirectTransportResponse(response) {
    if (!response) {
      return tpl(messages.messageSent);
    }

    if (response.pending && response.pending.length > 0) {
      throw createMailError({
        message: tpl(messages.reason, { reason: 'Email has been temporarily rejected' }),
      });
    }

    if (response.errors && response.errors.length > 0) {
      throw createMailError({
        message: tpl(messages.reason, { reason: response.errors[0].message }),
      });
    }

    return tpl(messages.messageSent);
  }
};
