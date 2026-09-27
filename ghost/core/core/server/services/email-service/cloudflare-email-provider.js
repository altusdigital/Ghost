const crypto = require('crypto');
const logging = require('@tryghost/logging');
const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-service:cloudflare-provider-service');
const { escapeExpression } = require('handlebars');

/**
 * Sends bulk email through Cloudflare Email Service.
 * Personalization happens here: Cloudflare has no recipient-variable syntax.
 */
class CloudflareEmailProvider {
  #client;
  #config;
  #settings;
  #urlUtils;

  /**
   * @param {object} dependencies
   * @param {import('../lib/cloudflare-email-client')} dependencies.client
   * @param {{get: (key: string) => unknown}} dependencies.config
   * @param {{get: (key: string) => unknown}} [dependencies.settings]
   * @param {{urlFor: Function}} [dependencies.urlUtils]
   */
  constructor({ client, config, settings, urlUtils }) {
    this.#client = client;
    this.#config = config;
    this.#settings = settings;
    this.#urlUtils = urlUtils;
  }

  /**
   * @param {import('./sending-service').EmailData} data
   * @param {import('./sending-service').EmailSendingOptions} options
   */
  async send(data, options) {
    const {
      subject,
      html,
      plaintext,
      from,
      domainOverride,
      replyTo,
      emailId,
      recipients,
      replacementDefinitions,
    } = data;

    logging.info(`Sending email to ${recipients.length} recipients`);
    const startTime = Date.now();

    try {
      if (recipients.length !== 1) {
        throw new errors.IncorrectUsageError({
          message: 'Cloudflare Email sends one recipient at a time',
        });
      }

      const recipient = recipients[0];
      const rendered = this.#personalize(
        html,
        plaintext,
        replacementDefinitions,
        recipient.replacements,
      );
      if (options.openTrackingEnabled && emailId) {
        rendered.html = this.#addOpenPixel(rendered.html, emailId, recipient.email);
      }

      const response = await this.#client.send(
        {
          subject,
          html: rendered.html,
          plaintext: rendered.plaintext,
          from,
          replyTo,
          domainOverride,
          id: emailId,
        },
        {
          [recipient.email]: listUnsubscribeVars(recipient.replacements),
        },
        [],
      );

      debug(`sent message (${Date.now() - startTime}ms)`);
      return {
        id: response?.id ? response.id.trim().replace(/^<|>$/g, '') : null,
      };
    } catch (e) {
      const error = e.error || e;
      debug(`failed to send message (${Date.now() - startTime}ms)`);
      throw new errors.EmailError({
        statusCode: error.status,
        message: `${error.message || 'Cloudflare Email error'}`.slice(0, 2000),
        errorDetails: e.messageData
          ? JSON.stringify({ error, messageData: e.messageData })
          : undefined,
        context: error.details
          ? `Cloudflare Email ${error.status}: ${error.details}`
          : 'Cloudflare Email error',
        help: 'https://developers.cloudflare.com/email-service/',
        code: 'BULK_EMAIL_SEND_FAILED',
      });
    }
  }

  getMaximumRecipients() {
    return this.#client.getBatchSize();
  }

  getTargetDeliveryWindow() {
    return this.#client.getTargetDeliveryWindow();
  }

  #personalize(html, plaintext, replacementDefinitions = [], replacements = []) {
    const byId = new Map(
      (replacements || []).map((replacement) => [replacement.id, replacement.value]),
    );
    let renderedHtml = html;
    let renderedText = plaintext;

    for (const def of replacementDefinitions) {
      const raw = byId.has(def.id) ? byId.get(def.id) : '';
      const textValue = raw ?? '';
      const htmlValue =
        !def.trusted && typeof textValue === 'string' ? escapeExpression(textValue) : textValue;
      if (renderedHtml) {
        renderedHtml = renderedHtml.replace(def.token, htmlValue);
      }
      if (renderedText) {
        renderedText = renderedText.replace(def.token, textValue);
      }
    }

    return { html: renderedHtml, plaintext: renderedText };
  }

  #addOpenPixel(html, emailId, recipient) {
    if (!html || !this.#settings || !this.#urlUtils) {
      return html;
    }
    const secret = this.#settings.get('members_email_auth_secret');
    if (!secret) {
      return html;
    }
    const payload = `${emailId}:${recipient}`;
    const key = crypto.createHmac('sha256', String(secret)).update(payload).digest('hex');
    const siteUrl = this.#urlUtils.urlFor('home', true);
    const url = new URL(siteUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/email/open/`;
    url.searchParams.set('e', emailId);
    url.searchParams.set('m', recipient);
    url.searchParams.set('k', key);
    const pixel = `<img src="${url.href}" alt="" width="1" height="1" style="display:block;height:1px;width:1px" />`;
    if (html.includes('</body>')) {
      return html.replace('</body>', `${pixel}</body>`);
    }
    return `${html}${pixel}`;
  }
}

function listUnsubscribeVars(replacements = []) {
  const vars = {};
  for (const replacement of replacements) {
    if (replacement.id === 'list_unsubscribe' && replacement.value) {
      vars.list_unsubscribe = replacement.value;
    }
  }
  return vars;
}

module.exports = CloudflareEmailProvider;
