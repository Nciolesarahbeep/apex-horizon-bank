// "This device" cookie: a long-lived random token, stored hashed in
// known_devices, so a browser update (which changes the user agent the
// fingerprint in lib/fraud.js is made from) doesn't make a phone look new.
// Set after every completed sign-in (password, emailed code, Face ID or
// passcode). Passcode sign-in is only allowed on a device carrying it.
const crypto = require('crypto');
const { parseCookies, appendSetCookie } = require('./auth');

const DEVICE_COOKIE = 'ahb_dev';

function deviceCookieFingerprint(token) {
  return 'c' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 31);
}

function readDeviceToken(req) {
  const token = parseCookies(req)[DEVICE_COOKIE];
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

async function knownByDeviceCookie(sql, userId, req) {
  const token = readDeviceToken(req);
  if (!token) return false;
  const rows = await sql`SELECT 1 FROM known_devices WHERE user_id = ${userId} AND device_fingerprint = ${deviceCookieFingerprint(token)} LIMIT 1`;
  return rows.length > 0;
}

const appendCookie = appendSetCookie;

async function rememberThisDevice(sql, req, res, userId) {
  try {
    const token = readDeviceToken(req) || crypto.randomBytes(32).toString('hex');
    await sql`
      INSERT INTO known_devices (user_id, device_fingerprint, user_agent)
      VALUES (${userId}, ${deviceCookieFingerprint(token)}, ${(req.headers && req.headers['user-agent']) || 'unknown'})
      ON CONFLICT (user_id, device_fingerprint) DO NOTHING
    `;
    appendCookie(res, `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  } catch (err) {
    console.error('Remember device error (non-fatal):', err);
  }
}

module.exports = { DEVICE_COOKIE, deviceCookieFingerprint, readDeviceToken, knownByDeviceCookie, rememberThisDevice, appendCookie };
