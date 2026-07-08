const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'apex-horizon-dev-secret-change-in-prod';
const CHALLENGE_COOKIE_NAME = 'ahb_webauthn_challenge';
const CHALLENGE_TTL_SECONDS = 5 * 60;

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
  res.setHeader('Set-Cookie', cookieParts.join('; '));
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
  res.setHeader('Set-Cookie', cookieParts.join('; '));
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
const RP_ID = process.env.WEBAUTHN_RP_ID || 'apex-horizon-bank-eight.vercel.app';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || `https://${RP_ID}`;

module.exports = {
  setChallengeCookie,
  clearChallengeCookie,
  readChallengeCookie,
  RP_NAME,
  RP_ID,
  ORIGIN,
};
