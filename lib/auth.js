const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const JWT_SECRET = process.env.JWT_SECRET || 'apex-horizon-dev-secret-change-in-prod';
const COOKIE_NAME = 'apex_session';
const TOKEN_TTL_SECONDS = 60 * 30; // 30 minutes — bank-like absolute session limit

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Decodes without verifying signature/expiry — only used at logout time to
// pull the jti out of a token so we can revoke its session row, even if the
// token happens to be right at the edge of expiring.
function decodeTokenUnsafe(token) {
  try {
    return jwt.decode(token);
  } catch (err) {
    return null;
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateSessionId() {
  return crypto.randomUUID();
}

// Fails open on missing/unknown jti or DB errors — tokens issued before this
// feature shipped have no jti and must keep working; a transient DB hiccup
// should not lock every signed-in user out of the app.
async function isSessionActive(jti) {
  if (!jti) return true;
  try {
    const rows = await sql`SELECT revoked_at FROM user_sessions WHERE jti = ${jti} LIMIT 1`;
    if (rows.length === 0) return true;
    return rows[0].revoked_at === null;
  } catch (err) {
    console.error('Session validity check failed:', err);
    return true;
  }
}

function deriveDeviceName(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android Device';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux Device';
  return 'Unknown Device';
}

function getRequestIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

async function createSession(userId, req) {
  const jti = generateSessionId();
  const userAgent = req.headers['user-agent'] || null;
  const deviceName = deriveDeviceName(userAgent);
  const ipAddress = getRequestIp(req);

  await sql`
    INSERT INTO user_sessions (jti, user_id, device_name, ip_address, user_agent, created_at, last_seen_at)
    VALUES (${jti}, ${userId}, ${deviceName}, ${ipAddress}, ${userAgent}, NOW(), NOW())
  `;

  return jti;
}

async function revokeSessionByJti(jti, userId) {
  if (!jti) return false;
  const rows = await sql`
    UPDATE user_sessions SET revoked_at = NOW()
    WHERE jti = ${jti} AND user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${TOKEN_TTL_SECONDS}`,
  ];
  if (isProd) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const cookieParts = [
    `${COOKIE_NAME}=`,
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

// NOTE: this is now ASYNC (it does a DB lookup to check session revocation).
// Every caller must be updated to `await getUserFromRequest(req)`.
async function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  const active = await isSessionActive(payload.jti);
  if (!active) return null;
  return payload;
}

module.exports = {
  signToken,
  verifyToken,
  decodeTokenUnsafe,
  normalizeEmail,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  getUserFromRequest,
  createSession,
  revokeSessionByJti,
  isSessionActive,
  COOKIE_NAME,
};
