const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'apex-horizon-dev-secret-change-in-prod';
const CHALLENGE_COOKIE_NAME = 'ahb_webauthn_challenge';
const CHALLENGE_TTL_SECONDS = 5 * 60;

// Keep any cookie already on the response (see lib/auth.js appendSetCookie).
function appendSetCookie(res, cookie) {
  const prev = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : (res.headers && res.headers['Set-Cookie']);
  res.setHeader('Set-Cookie', [].concat(prev || [], cookie));
}

function setChallengeCookie(res, challenge, extra) {
  const token = jwt.sign({ challenge, ...extra }, JWT_SECRET, { expiresIn: CHALLENGE_TTL_SECONDS });
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${CHALLENGE_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${CHALLENGE_TTL_SECONDS}`,
  ];
  if (isProd) cookieParts.push('Secure');
  appendSetCookie(res, cookieParts.join('; '));
}

function clearChallengeCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${CHALLENGE_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProd) cookieParts.push('Secure');
  appendSetCookie(res, cookieParts.join('; '));
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function readChallengeCookie(req) {
  const cookies = parseCookies(req);
  const token = cookies[CHALLENGE_COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

const RP_NAME = 'Apex Horizon Bank';
// Face ID keys belong to the web address they were made on. The app lives
// at apexhorizonbank.com (the old vercel.app address now redirects there,
// see vercel.json); WEBAUTHN_RP_IDS can add more addresses if ever needed,
// and each request uses the address it came in on when it's one of ours.
const RP_ID = process.env.WEBAUTHN_RP_ID || 'apexhorizonbank.com';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;
const RP_IDS = new Set([
  RP_ID,
  'apexhorizonbank.com',
  ...String(process.env.WEBAUTHN_RP_IDS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

function requestHost(req) {
  const h = (req && req.headers) || {};
  return String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
}

// { rpID, origin } for this request: the host it came in on when that's one
// of Apex's addresses, otherwise the main domain.
function relyingParty(req) {
  const host = requestHost(req);
  const rpID = RP_IDS.has(host) ? host : RP_ID;
  let origin = `https://${rpID}`;
  try { if (process.env.WEBAUTHN_ORIGIN && new URL(process.env.WEBAUTHN_ORIGIN).hostname === rpID) origin = process.env.WEBAUTHN_ORIGIN; } catch (e) {}
  return { rpID, origin };
}

module.exports = {
  setChallengeCookie,
  clearChallengeCookie,
  readChallengeCookie,
  RP_NAME,
  RP_ID,
  ORIGIN,
  relyingParty,
};
