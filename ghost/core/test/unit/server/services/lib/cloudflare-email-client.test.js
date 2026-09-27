const assert = require('node:assert/strict');
const CloudflareEmailClient = require('../../../../../core/server/services/lib/cloudflare-email-client');

const configured = {
  config: {
    get(key) {
      if (key === 'bulkEmail') {
        return {
          cloudflare: {
            accountId: 'account',
            apiToken: 'token',
            zoneId: 'zone',
            domain: 'email.example.com',
          },
        };
      }
      return undefined;
    },
  },
  settings: { get() {} },
};

describe('CloudflareEmailClient', function () {
  it('sends one recipient and returns a pending provider id', async function () {
    const calls = [];
    const client = new CloudflareEmailClient({
      ...configured,
      request: async (url, options) => {
        calls.push({ url, options });
        return {
          status: 200,
          body: {
            success: true,
            result: { delivered: ['reader@example.com'], permanent_bounces: [], queued: [] },
          },
        };
      },
    });

    const response = await client.send(
      {
        subject: 'Hello',
        html: '<p>Hi</p>',
        plaintext: 'Hi',
        from: 'news@email.example.com',
        id: 'email-id',
      },
      { 'reader@example.com': { list_unsubscribe: 'https://example.com/unsubscribe/' } },
      [],
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /accounts\/account\/email\/sending\/send$/);
    const payload = JSON.parse(calls[0].options.body);
    assert.deepEqual(payload.to, ['reader@example.com']);
    assert.equal(payload.headers['List-Unsubscribe'], '<https://example.com/unsubscribe/>');
    assert.equal(payload.headers['X-Ghost-Email-Id'], 'email-id');
    assert.match(response.id, /^<pending\.[a-f0-9]+@email\.example\.com>$/);
  });

  it('retries a throttled send', async function () {
    let attempts = 0;
    const client = new CloudflareEmailClient({
      ...configured,
      request: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { status: 429, body: { success: false, errors: [{ message: 'throttled' }] } };
        }
        return {
          status: 200,
          body: {
            success: true,
            result: { delivered: ['reader@example.com'], permanent_bounces: [], queued: [] },
          },
        };
      },
    });

    const response = await client.send(
      { subject: 'Hello', html: '<p>Hi</p>', plaintext: 'Hi', from: 'news@email.example.com' },
      { 'reader@example.com': {} },
      [],
    );
    assert.equal(attempts, 2);
    assert.ok(response.id);
  });

  it('rejects a permanent bounce from the send response', async function () {
    const client = new CloudflareEmailClient({
      ...configured,
      request: async () => ({
        status: 200,
        body: {
          success: true,
          result: { delivered: [], permanent_bounces: ['reader@example.com'], queued: [] },
        },
      }),
    });

    await assert.rejects(
      client.send(
        { subject: 'Hello', html: '<p>Hi</p>', plaintext: 'Hi', from: 'news@email.example.com' },
        { 'reader@example.com': {} },
        [],
      ),
      (err) => err.error && err.error.details === 'permanent_bounce',
    );
  });

  it('normalizes delivered, bounce, and complaint events', function () {
    const client = new CloudflareEmailClient({
      config: { get() {} },
      settings: { get() {} },
    });

    const delivered = client.normalizeEvent({
      messageId: 'msg-1',
      to: 'reader@example.com',
      subject: 'Hello',
      datetime: '2026-09-27T00:00:00.000Z',
      eventType: 'delivered',
    });
    assert.equal(delivered.type, 'delivered');
    assert.equal(delivered.providerId, 'msg-1');

    const bounced = client.normalizeEvent({
      messageId: 'msg-2',
      to: 'reader@example.com',
      datetime: '2026-09-27T00:00:00.000Z',
      eventType: 'message.bounced',
      errorDetail: '550 user unknown',
    });
    assert.equal(bounced.type, 'failed');
    assert.equal(bounced.severity, 'permanent');

    const complaint = client.normalizeEvent({
      messageId: 'msg-3',
      to: 'reader@example.com',
      datetime: '2026-09-27T00:00:00.000Z',
      eventType: 'message.complained',
    });
    assert.equal(complaint.type, 'complained');
  });

  it('refuses more than one recipient', async function () {
    const client = new CloudflareEmailClient(configured);
    await assert.rejects(
      client.send(
        { subject: 'Hello', html: '<p>Hi</p>', plaintext: 'Hi', from: 'news@email.example.com' },
        { 'a@example.com': {}, 'b@example.com': {} },
        [],
      ),
      (err) => {
        assert.match(err.message, /1 recipient at a time/);
        return true;
      },
    );
  });
});
