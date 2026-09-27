const crypto = require('crypto');
const url = require('url');
const logging = require('@tryghost/logging');
const { timingSafeStringEqual } = require('../../../../shared/timing-safe-string-equal');
const { settingsHelpers, recordEmailOpen } = require('../../proxy');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Records a newsletter open and returns a 1x1 gif.
 * Query: e (email id), m (member email), k (hmac).
 */
module.exports = async function emailOpenController(req, res) {
  const { query } = url.parse(req.url, true);
  try {
    const emailId = typeof query.e === 'string' ? query.e : '';
    const memberEmail = typeof query.m === 'string' ? query.m : '';
    const key = typeof query.k === 'string' ? query.k : '';
    const secret = settingsHelpers.getMembersValidationKey();
    if (emailId && memberEmail && key && secret) {
      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${emailId}:${memberEmail}`)
        .digest('hex');
      if (timingSafeStringEqual(expected, key)) {
        await recordEmailOpen(emailId, memberEmail);
      }
    }
  } catch (err) {
    logging.error(err);
  }

  res.writeHead(200, {
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store',
  });
  res.end(PIXEL);
};
