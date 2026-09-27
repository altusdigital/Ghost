import assert from 'node:assert/strict';
import sinon from 'sinon';

// @ts-expect-error This module lacks type definitions.
import CloudflareEmailClient from '../../../../../core/server/services/lib/cloudflare-email-client';
import { fetchMailgunEvents } from '../../../../../core/server/services/email-analytics/fetch-mailgun-events';

type FetchMailgunEventsOptions = Parameters<typeof fetchMailgunEvents>[0];

const DEFAULT_TAGS = ['bulk-email'];
const LATEST_TIMESTAMP = new Date('Thu Feb 25 2021 12:00:00 GMT+0000');
const END_EXAMPLE = new Date('Thu Feb 25 2021 14:00:00 GMT+0000');

describe('fetchMailgunEvents', function () {
  let config: FetchMailgunEventsOptions['config'];
  let settings: FetchMailgunEventsOptions['settings'];

  beforeEach(function () {
    config = { get() {} };
    settings = { get() {} };
  });

  afterEach(function () {
    sinon.restore();
  });

  function stubFetch() {
    return sinon.stub(CloudflareEmailClient.prototype, 'fetchEvents').resolves();
  }

  it('passes the Cloudflare poll window to the client', async function () {
    const fetchEventsStub = stubFetch();
    const batchHandler = sinon.spy();

    await fetchMailgunEvents({
      config,
      settings,
      tags: DEFAULT_TAGS,
      batchHandler,
      begin: LATEST_TIMESTAMP,
    });

    assert.equal(fetchEventsStub.firstCall.args[0].limit, 50);
    assert.equal(fetchEventsStub.firstCall.args[0].begin, LATEST_TIMESTAMP.getTime() / 1000);
    assert.equal(fetchEventsStub.firstCall.args[0].end, undefined);
    assert.deepEqual(fetchEventsStub.firstCall.args[2], { maxEvents: undefined });
  });

  it('returns the domain-safe cursor from the Cloudflare client', async function () {
    const safeCursor = new Date('Thu Feb 25 2021 13:00:00 GMT+0000');
    sinon.stub(CloudflareEmailClient.prototype, 'fetchEvents').resolves({ safeCursor });

    const result = await fetchMailgunEvents({
      config,
      settings,
      tags: DEFAULT_TAGS,
      batchHandler: sinon.spy(),
    });

    assert.deepEqual(result, { safeCursor });
  });

  it('uses supplied end timestamp and max events', async function () {
    const fetchEventsStub = stubFetch();

    await fetchMailgunEvents({
      config,
      settings,
      tags: DEFAULT_TAGS,
      batchHandler: sinon.spy(),
      begin: LATEST_TIMESTAMP,
      end: END_EXAMPLE,
      maxEvents: 1000,
    });

    assert.equal(fetchEventsStub.firstCall.args[0].end, END_EXAMPLE.getTime() / 1000);
    assert.deepEqual(fetchEventsStub.firstCall.args[2], { maxEvents: 1000 });
  });

  it('forwards normalized events through the batch handler', async function () {
    const batchHandler = sinon.spy();
    sinon
      .stub(CloudflareEmailClient.prototype, 'fetchEvents')
      .callsFake(async (_options, handler) => {
        await handler([
          { type: 'delivered', providerId: 'msg-1', recipientEmail: 'a@example.com' },
        ]);
      });

    await fetchMailgunEvents({
      config,
      settings,
      tags: DEFAULT_TAGS,
      batchHandler,
    });

    assert.equal(batchHandler.calledOnce, true);
    assert.equal(batchHandler.firstCall.args[0][0].providerId, 'msg-1');
  });
});
