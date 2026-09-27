const crypto = require('crypto');
const logging = require('@tryghost/logging');
const metrics = require('@tryghost/metrics');
const errors = require('@tryghost/errors');

const API_BASE = 'https://api.cloudflare.com/client/v4';
const GRAPHQL_URL = `${API_BASE}/graphql`;
const MAX_RECIPIENTS = 1;
const RETRY_LIMIT = 3;
const DEFAULT_PAGE_LIMIT = 50;

/**
 * @typedef {object} CloudflareConfig
 * @prop {string} accountId
 * @prop {string} apiToken
 * @prop {string} zoneId
 * @prop {string} domain
 */

/**
 * Cloudflare Email Service client.
 *
 * Bulk and transactional sends use the REST API. Events are polled from the
 * GraphQL dataset `emailSendingAdaptive` and normalized into the shape Ghost's
 * analytics jobs already understand.
 */
module.exports = class CloudflareEmailClient {
  #config;
  #settings;
  #request;

  /**
   * @param {object} dependencies
   * @param {{get: (key: string) => unknown}} dependencies.config
   * @param {{get: (key: string) => unknown}} dependencies.settings
   * @param {(url: string, options: object) => Promise<{status: number, body: any}>} [dependencies.request]
   */
  constructor({ config, settings, request }) {
    this.#config = config;
    this.#settings = settings;
    this.#request = request || defaultRequest;
  }

  /**
   * Sends one personalized message per recipient.
   *
   * Cloudflare does not return a Message-ID from the REST API. Callers store a
   * pending id; analytics replaces it with the provider id once an event arrives.
   *
   * @param {object} message
   * @param {Record<string, Record<string, string>>} recipientData
   * @param {Array<{format: string, regexp: RegExp, id: string}>} [replacements]
   * @returns {Promise<{id: string|null}|null>}
   */
  async send(message, recipientData, replacements = []) {
    const cfConfig = this.#getConfig();
    if (!cfConfig) {
      logging.warn('Cloudflare Email is not configured');
      return null;
    }

    const recipients = Object.keys(recipientData || {});
    if (recipients.length > MAX_RECIPIENTS) {
      throw new errors.IncorrectUsageError({
        message: `Cloudflare Email only supports sending to ${MAX_RECIPIENTS} recipient at a time`,
      });
    }

    if (recipients.length === 0) {
      throw new errors.IncorrectUsageError({
        message: 'Cloudflare Email send requires a recipient',
      });
    }

    const recipient = recipients[0];
    const content = applyReplacements(message, recipientData[recipient], replacements);
    const headers = buildHeaders(message, recipientData[recipient]);
    const pendingId = `pending.${crypto.randomBytes(16).toString('hex')}`;

    const payload = {
      to: [recipient],
      from: message.from,
      subject: content.subject,
      html: content.html,
      text: content.plaintext,
      headers,
    };
    if (message.replyTo || message.reply_to) {
      payload.reply_to = message.replyTo || message.reply_to;
    }

    const startTime = Date.now();
    try {
      const body = await this.#postSend(cfConfig, payload);
      const result = body?.result || {};
      const permanent = Array.isArray(result.permanent_bounces) ? result.permanent_bounces : [];
      if (permanent.includes(recipient)) {
        const error = new errors.BadRequestError({
          message: `Permanent bounce for ${recipient}`,
        });
        error.status = 400;
        error.details = 'permanent_bounce';
        throw Object.assign(error, { error, messageData: payload });
      }

      metrics.metric('cloudflare-send-mail', {
        value: Date.now() - startTime,
        statusCode: 200,
      });

      return { id: `<${pendingId}@${cfConfig.domain}>` };
    } catch (error) {
      metrics.metric('cloudflare-send-mail', {
        value: Date.now() - startTime,
        statusCode: error.status,
      });
      if (error.error && error.messageData) {
        throw error;
      }
      logging.error(error);
      return Promise.reject({
        error: {
          status: error.status,
          message: error.message,
          details: error.details,
        },
        messageData: payload,
      });
    }
  }

  /**
   * Transactional send used by GhostMailer. Returns a nodemailer-like result.
   *
   * @param {object} message
   * @returns {Promise<{messageId: string, accepted: string[]}>}
   */
  async sendTransactional(message) {
    const response = await this.send(
      {
        subject: message.subject,
        html: message.html,
        plaintext: message.text,
        from: message.from,
        replyTo: message.replyTo,
        headers: message.headers,
      },
      { [message.to]: {} },
      [],
    );

    if (!response?.id) {
      throw new errors.EmailError({
        message: 'Cloudflare Email did not accept the message',
        code: 'EMAIL_NOT_ACCEPTED',
      });
    }

    return {
      messageId: response.id,
      accepted: [message.to],
    };
  }

  /**
   * @param {object} options
   * @param {number} [options.begin] Unix seconds
   * @param {number} [options.end] Unix seconds
   * @param {number} [options.limit]
   * @param {Function} batchHandler
   * @param {{maxEvents?: number}} [fetchOptions]
   */
  async fetchEvents(options, batchHandler, { maxEvents = Infinity } = {}) {
    const cfConfig = this.#getConfig();
    if (!cfConfig?.zoneId) {
      logging.warn('Cloudflare Email is not configured');
      return;
    }

    const domains = this.#getDomainsToFetch(cfConfig);
    const cappedDomainCursors = [];

    for (const domain of domains) {
      const result = await this.#fetchEventsFromDomain(domain, cfConfig, options, batchHandler, {
        maxEvents,
      });
      if (
        result.capped &&
        result.lastEventTimestamp &&
        Number.isFinite(result.lastEventTimestamp.getTime())
      ) {
        cappedDomainCursors.push(result.lastEventTimestamp);
      }
    }

    const safeCursor = cappedDomainCursors.reduce(
      (earliest, cursor) => (!earliest || cursor < earliest ? cursor : earliest),
      undefined,
    );

    return { safeCursor };
  }

  async #fetchEventsFromDomain(domain, cfConfig, options, batchHandler, { maxEvents }) {
    const startDate = new Date();
    let eventCount = 0;
    let lastEventTimestamp;
    let capped = false;
    let cursor = options.begin
      ? new Date(options.begin * 1000)
      : new Date(Date.now() - 30 * 60 * 1000);
    const end = options.end ? new Date(options.end * 1000) : startDate;
    const seen = new Set();

    while (eventCount < maxEvents) {
      const page = await this.#queryEvents(cfConfig, domain, cursor, end, options.limit);
      const events = page
        .map((item) => this.normalizeEvent(item))
        .filter((event) => {
          if (!event || event.timestamp > startDate) {
            return false;
          }
          const key = `${event.providerId}:${event.type}:${event.recipientEmail}:${event.timestamp.toISOString()}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });

      if (events.length === 0) {
        break;
      }

      await batchHandler(events);
      eventCount += events.length;
      lastEventTimestamp = events[events.length - 1].timestamp;

      const beginTimestamp = options.begin ? Math.ceil(options.begin * 1000) : undefined;
      if (
        eventCount >= maxEvents &&
        (!beginTimestamp || lastEventTimestamp.getTime() > beginTimestamp)
      ) {
        capped = true;
        break;
      }

      const nextCursor = new Date(lastEventTimestamp.getTime() + 1);
      if (nextCursor >= end) {
        break;
      }
      cursor = nextCursor;
    }

    return { capped, eventCount, lastEventTimestamp };
  }

  async #queryEvents(cfConfig, domain, start, end, limit = DEFAULT_PAGE_LIMIT) {
    const query = `query RecentEmailEvents($zoneTag: string!, $start: Time!, $end: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          emailSendingAdaptive(
            filter: { datetime_geq: $start, datetime_leq: $end, sendingDomain: "${domain}" }
            limit: ${Number(limit) || DEFAULT_PAGE_LIMIT}
            orderBy: [datetime_ASC]
          ) {
            datetime
            from
            to
            subject
            status
            eventType
            sendingDomain
            messageId
            errorCause
            errorDetail
          }
        }
      }
    }`;

    const body = await this.#requestJson(GRAPHQL_URL, cfConfig.apiToken, {
      query,
      variables: {
        zoneTag: cfConfig.zoneId,
        start: start.toISOString(),
        end: end.toISOString(),
      },
    });

    return body?.data?.viewer?.zones?.[0]?.emailSendingAdaptive || [];
  }

  /**
   * Maps a Cloudflare sending event onto Ghost's analytics event shape.
   * Opens are recorded by the Ghost pixel, not by Cloudflare.
   *
   * @param {object} event
   * @returns {object|null}
   */
  normalizeEvent(event) {
    const rawId = event?.messageId || event?.message?.headers?.['message-id'];
    const providerId = typeof rawId === 'string' ? rawId.replace(/^<|>$/g, '') : rawId;
    const recipientEmail = event?.to || event?.recipient;
    if (!providerId || !recipientEmail) {
      logging.error('Received invalid event from Cloudflare Email');
      logging.error(event);
      return null;
    }

    const rawType = event?.eventType || event?.status || event?.event;
    let mapped = mapEventType(rawType);
    if (mapped?.type === 'failed' && event?.severity === 'temporary') {
      mapped = { type: 'failed', severity: 'temporary' };
    } else if (mapped?.type === 'failed' && event?.severity === 'permanent') {
      mapped = { type: 'failed', severity: 'permanent' };
    }
    if (!mapped) {
      mapped = { type: String(rawType || 'unknown') };
    }

    const timestamp = eventTimestamp(event);
    if (Number.isNaN(timestamp.getTime())) {
      logging.error('Received invalid event from Cloudflare Email');
      logging.error(event);
      return null;
    }

    const deliveryStatus = event?.['delivery-status'];
    const error = event?.errorDetail
      ? {
          code: event.errorCause || null,
          message: String(event.errorDetail).substring(0, 2000),
          enhancedCode: null,
        }
      : deliveryStatus
        ? {
            code: deliveryStatus.code ?? null,
            message: String(deliveryStatus.description || deliveryStatus.message || '').substring(
              0,
              2000,
            ),
            enhancedCode: deliveryStatus['enhanced-code'] ?? null,
          }
        : null;

    return {
      id: event.id || `${providerId}:${mapped.type}:${recipientEmail}`,
      type: mapped.type,
      severity: mapped.severity,
      recipientEmail,
      subject: event.subject || event?.message?.headers?.subject,
      providerId,
      timestamp,
      error,
    };
  }

  async removeSuppression(email) {
    if (!this.isConfigured()) {
      return false;
    }
    const cfConfig = this.#getConfig();
    try {
      await this.#requestJson(
        `${API_BASE}/accounts/${cfConfig.accountId}/email/sending/suppressions`,
        cfConfig.apiToken,
        { email, domain: cfConfig.domain },
        'DELETE',
      );
      return true;
    } catch (err) {
      logging.error(err);
      return false;
    }
  }

  async removeBounce(email) {
    return this.removeSuppression(email);
  }

  async removeComplaint(email) {
    return this.removeSuppression(email);
  }

  async removeUnsubscribe(email) {
    return this.removeSuppression(email);
  }

  isConfigured() {
    return !!this.#getConfig();
  }

  getInstance() {
    return this.isConfigured() ? this : null;
  }

  getBatchSize() {
    return MAX_RECIPIENTS;
  }

  getTargetDeliveryWindow() {
    const targetDeliveryWindow = this.#config.get('bulkEmail')?.targetDeliveryWindow;
    if (
      targetDeliveryWindow === undefined ||
      !Number.isInteger(parseInt(targetDeliveryWindow)) ||
      parseInt(targetDeliveryWindow) < 0
    ) {
      return 0;
    }
    return parseInt(targetDeliveryWindow);
  }

  async #postSend(cfConfig, payload) {
    return this.#requestJson(
      `${API_BASE}/accounts/${cfConfig.accountId}/email/sending/send`,
      cfConfig.apiToken,
      payload,
    );
  }

  async #requestJson(url, token, payload, method = 'POST') {
    let attempt = 0;
    let lastError;
    while (attempt < RETRY_LIMIT) {
      attempt += 1;
      const response = await this.#request(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 429 && attempt < RETRY_LIMIT) {
        await delay(250 * attempt);
        continue;
      }

      const body = response.body;
      if (response.status >= 400 || body?.success === false) {
        const apiError = body?.errors?.[0] || {};
        lastError = new errors.InternalServerError({
          message: apiError.message || `Cloudflare Email request failed (${response.status})`,
        });
        lastError.status = response.status;
        lastError.details = apiError.message;
        throw lastError;
      }
      return body;
    }
    throw lastError;
  }

  /**
   * @returns {CloudflareConfig|null}
   */
  #getConfig() {
    const bulkEmailConfig = this.#config.get('bulkEmail');
    const fromSettings = {
      accountId: this.#settings?.get?.('cloudflare_account_id'),
      apiToken: this.#settings?.get?.('cloudflare_api_token'),
      zoneId: this.#settings?.get?.('cloudflare_zone_id'),
      domain: this.#settings?.get?.('cloudflare_sending_domain'),
    };
    const fromConfig = bulkEmailConfig?.cloudflare;
    const chosen = fromConfig?.apiToken && fromConfig?.accountId ? fromConfig : fromSettings;
    if (!isUsableCloudflareConfig(chosen)) {
      return null;
    }
    return {
      accountId: chosen.accountId,
      apiToken: chosen.apiToken,
      zoneId: chosen.zoneId,
      domain: chosen.domain,
    };
  }

  #getDomainsToFetch(cfConfig) {
    const domains = [cfConfig.domain];
    const fallbackDomain = this.#config.get('hostSettings:managedEmail:fallbackDomain');
    if (fallbackDomain && fallbackDomain !== cfConfig.domain) {
      domains.push(fallbackDomain);
    }
    return domains;
  }
};

function isUsableCloudflareConfig(chosen) {
  return Boolean(
    chosen &&
    typeof chosen.apiToken === 'string' &&
    chosen.apiToken.length > 0 &&
    typeof chosen.accountId === 'string' &&
    chosen.accountId.length > 0 &&
    typeof chosen.domain === 'string' &&
    chosen.domain.includes('.'),
  );
}

function applyReplacements(message, recipientVars, replacements) {
  const content = {
    subject: message.subject,
    html: message.html,
    plaintext: message.plaintext,
  };
  for (const replacement of replacements || []) {
    const value = recipientVars?.[replacement.id] ?? '';
    if (content[replacement.format]) {
      content[replacement.format] = content[replacement.format].replace(replacement.regexp, value);
    }
  }
  return content;
}

function buildHeaders(message, recipientVars) {
  const headers = {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'OOF, AutoReply',
  };
  if (message?.id) {
    headers['X-Ghost-Email-Id'] = String(message.id);
  }
  if (recipientVars?.list_unsubscribe) {
    headers['List-Unsubscribe'] = `<${recipientVars.list_unsubscribe}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  if (message?.headers && typeof message.headers === 'object') {
    Object.assign(headers, message.headers);
  }
  return headers;
}

function eventTimestamp(event) {
  if (event?.datetime) {
    return new Date(event.datetime);
  }
  if (event?.timestamp === undefined || event?.timestamp === null) {
    return new Date(NaN);
  }
  const numeric = Number(event.timestamp);
  if (Number.isNaN(numeric)) {
    return new Date(event.timestamp);
  }
  return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
}

function mapEventType(eventType) {
  const value = String(eventType || '').toLowerCase();
  if (value === 'opened' || value === 'open') {
    return { type: 'opened' };
  }
  if (value.includes('unsubscrib')) {
    return { type: 'unsubscribed' };
  }
  if (value.includes('delivered')) {
    return { type: 'delivered' };
  }
  if (value.includes('complain')) {
    return { type: 'complained' };
  }
  if (value.includes('deferred') || value.includes('soft') || value.includes('temporary')) {
    return { type: 'failed', severity: 'temporary' };
  }
  if (
    value.includes('bounce') ||
    value.includes('failed') ||
    value.includes('reject') ||
    value.includes('permanent')
  ) {
    return { type: 'failed', severity: 'permanent' };
  }
  return null;
}

async function defaultRequest(url, options) {
  const response = await fetch(url, options);
  let body = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (err) {
      body = { raw: text };
    }
  }
  return { status: response.status, body };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
