// # Frontend Route tests
// As it stands, these tests depend on the database, and as such are integration tests.
// Mocking out the models to not touch the DB would turn these into unit tests, and should probably be done in future,
// But then again testing real code, rather than mock code, might be more useful...
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { assertExists } = require('../utils/assertions');
const sinon = require('sinon');
const supertest = require('supertest');
const cheerio = require('cheerio');

function objectId() {
  return crypto.randomBytes(12).toString('hex');
}

const testUtils = require('../utils');
const config = require('../../core/shared/config');

describe('Frontend Routing: Email Routes', function () {
  let request;
  let emailPosts;

  beforeAll(async function () {
    await testUtils.startGhost({ forceStart: true });

    request = supertest.agent(config.get('url'));

    emailPosts = await testUtils.fixtures.insertPosts([
      {
        title: 'I am visible through email route!',
        status: 'sent',
        posts_meta: {
          email_only: true,
        },
      },
      {
        title: 'I am NOT visible through email route!',
        status: 'draft',
        posts_meta: {
          email_only: true,
        },
      },
    ]);
  });

  afterAll(function () {
    sinon.restore();
  });

  it('should display email_only post', async function () {
    const res = await request
      .get(`/email/${emailPosts[0].get('uuid')}/`)
      .expect('Content-Type', /html/)
      .expect(200);

    const $ = cheerio.load(res.text);

    assert.equal($('title').text(), 'I am visible through email route!');

    assert.equal(res.headers['x-cache-invalidate'], undefined);
    assert.equal(res.headers['X-CSRF-Token'], undefined);
    assert.equal(res.headers['set-cookie'], undefined);
    assertExists(res.headers.date);
  });

  it('404s for draft email only post', function () {
    return request.get(`/email/${emailPosts[1].get('uuid')}/`).expect(404);
  });

  it('404s known slug', function () {
    return request.get(`/email/${emailPosts[0].get('slug')}/`).expect(404);
  });

  it('404s unknown slug', function () {
    return request.get('/email/random-slug/').expect(404);
  });

  it('records an open from a signed pixel and ignores a bad signature', async function () {
    const db = require(String('../../core/server/data/db'));
    const settingsCache = require(String('../../core/shared/settings-cache'));
    const emailId = objectId();
    const batchId = objectId();
    const memberId = objectId();
    const memberEmail = 'open-pixel@example.com';
    const now = new Date();
    const secret = settingsCache.get('members_email_auth_secret');
    const key = crypto
      .createHmac('sha256', secret)
      .update(`${emailId}:${memberEmail}`)
      .digest('hex');

    await db.knex('emails').insert({
      id: emailId,
      post_id: emailPosts[0].id,
      uuid: '6f0e2c4a-1b2d-4e5f-8a90-1234567890ab',
      status: 'submitted',
      recipient_filter: 'all',
      email_count: 1,
      delivered_count: 0,
      opened_count: 0,
      failed_count: 0,
      submitted_at: now,
      created_at: now,
      updated_at: now,
    });
    await db.knex('email_batches').insert({
      id: batchId,
      email_id: emailId,
      status: 'submitted',
      created_at: now,
      updated_at: now,
    });
    await db.knex('email_recipients').insert({
      id: objectId(),
      email_id: emailId,
      member_id: memberId,
      batch_id: batchId,
      member_uuid: '6f0e2c4a-1b2d-4e5f-8a90-1234567890ac',
      member_email: memberEmail,
      member_name: 'Open Pixel',
    });

    const http = require('http');
    const fetchPath = (path) => {
      const base = new URL(config.get('url'));
      return new Promise((resolve, reject) => {
        const req = http.get({ hostname: base.hostname, port: base.port, path }, (res) => {
          res.resume();
          res.on('end', () => {
            resolve({
              status: res.statusCode,
              type: res.headers['content-type'],
            });
          });
        });
        req.on('error', reject);
      });
    };
    const openPath = `/email/open/?e=${emailId}&m=${encodeURIComponent(memberEmail)}&k=${key}`;
    const opened = await fetchPath(openPath);
    assert.equal(opened.status, 200);
    assert.equal(opened.type, 'image/gif');

    const row = await db.knex('email_recipients').where({ email_id: emailId }).first();
    assert.ok(row.opened_at);

    await db.knex('email_recipients').where({ email_id: emailId }).update({ opened_at: null });
    const ignored = await fetchPath(
      `/email/open/?e=${emailId}&m=${encodeURIComponent(memberEmail)}&k=not-the-signature`,
    );
    assert.equal(ignored.status, 200);
    assert.equal(ignored.type, 'image/gif');

    const unchanged = await db.knex('email_recipients').where({ email_id: emailId }).first();
    assert.equal(unchanged.opened_at, null);
  });
});
