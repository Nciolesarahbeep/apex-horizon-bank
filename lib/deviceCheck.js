// Two-step sign-in for devices we haven't seen before.
//
// When the right password is entered on a device that isn't on the
// customer's known-device list, no session is created yet. Instead we email a
// 6-digit code and wait for it. The code is:
//   - kept on the server only (a keyed hash of it, never sent to the app),
//   - good for 10 minutes and for one sign-in,
//   - locked after 5 wrong tries (and the count never resets, even when a
//     new code is sent),
//   - tied to the device that asked for it.
// A new code can be sent 30 seconds after the last one, up to 3 times, and a
// customer can have at most 5 new-device checks started an hour.
//
// If the email can't be sent, customers who have set an app passcode confirm
// with that instead. Anyone else is let in, with the new-device alert that
// every new-device sign-in already creates, so a mail outage never locks
// people out of their money.
//
// Not asked: the very first device an account signs in on, Face ID (a
// Face ID key already proves it's you on that device) and the recruiter demo
// account (DEMO_EMAIL), whose inbox visitors can't see.

const crypto = require('crypto');
const { layout, detailsTable, highlightBox, notice, p, h } = require('./emailLayout');

const CODE_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_AFTER_SECONDS = 30;
const MAX_CHECKS_PER_HOUR = 5;
const SECRET = process.env.DEVICE_CODE_SECRET || process.env.JWT_SECRET || 'apex-horizon-dev-secret-change-in-prod';

class DeviceCheckError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'DeviceCheckError';
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

let schemaReady = false;
async function ensureDeviceCheckSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS login_challenges (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('email', 'passcode')),
      code_hash TEXT,
      fingerprint TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      resends INTEGER NOT NULL DEFAULT 0,
      last_sent_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS login_challenges_user_created ON login_challenges (user_id, created_at)`;
  schemaReady = true;
}

function isDemoAccount(email) {
  const demo = String(process.env.DEMO_EMAIL || '').trim().toLowerCase();
  return !!demo && String(email || '').trim().toLowerCase() === demo;
}

// known / isFirstDeviceEver come from lib/fraud.js isKnownDevice().
function needsDeviceCheck({ email, known, isFirstDeviceEver }) {
  if (known || isFirstDeviceEver) return false;
  if (isDemoAccount(email)) return false;
  return true;
}

function hashCode(challengeId, code) {
  return crypto.createHmac('sha256', SECRET).update(`${challengeId}:${String(code)}`).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex');
  const y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return 'your email';
  const shown = user.slice(0, Math.min(2, Math.max(1, user.length - 1)));
  return `${shown}${'•'.repeat(Math.max(2, Math.min(5, user.length - shown.length)))}@${domain}`;
}

function codeEmailHtml(code, { deviceLabel, location, date } = {}) {
  const when = date || new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
  return layout({
    preheader: `${code} is your Apex Horizon sign-in code.`,
    body: [
      h('Your sign-in code'),
      p('Someone signed in to your account with your password. To finish signing in, enter this code in the app:'),
      highlightBox(code, { label: 'Sign-in code', spacing: '0.2em' }),
      detailsTable([
        ['Device', deviceLabel],
        ['Location', location],
        ['Time', when],
        ['Code valid for', '10 minutes, one use'],
      ], { title: 'Sign-in attempt' }),
      notice("<strong>Wasn't you?</strong> Don't share this code with anyone and change your password in the app. Apex will never call, text or email you to ask for it.", 'alert'),
    ].join(''),
  });
}

function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Starts a check. Returns { challengeId, method, destination, ... } or
// { method: null } when neither email nor a passcode is available.
async function startDeviceCheck(sql, { user, fingerprint, sendEmail, deviceLabel, location }) {
  await ensureDeviceCheckSchema(sql);
  const recent = await sql`
    SELECT COUNT(*)::int AS n FROM login_challenges
    WHERE user_id = ${user.id} AND created_at > NOW() - INTERVAL '1 hour'
  `;
  if (Number(recent[0].n) >= MAX_CHECKS_PER_HOUR) {
    throw new DeviceCheckError(429, 'Too many sign-ins from new devices in the last hour. Please try again later, or sign in on a device you usually use.');
  }

  const challengeId = crypto.randomBytes(24).toString('hex');
  const code = newCode();
  const sent = await sendEmail({
    to: user.email,
    subject: `${code} is your Apex Horizon sign-in code`,
    html: codeEmailHtml(code, { deviceLabel, location }),
  });

  let method = null;
  if (sent) method = 'email';
  else if (user.passcode_hash) method = 'passcode';

  if (!method) return { method: null, emailFailed: true };

  await sql`
    INSERT INTO login_challenges (id, user_id, method, code_hash, fingerprint, last_sent_at, expires_at)
    VALUES (${challengeId}, ${user.id}, ${method}, ${method === 'email' ? hashCode(challengeId, code) : null}, ${fingerprint},
            ${method === 'email' ? new Date().toISOString() : null}, ${new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString()})
  `;
  return {
    challengeId,
    method,
    emailFailed: !sent,
    destination: method === 'email' ? maskEmail(user.email) : null,
    expiresInSeconds: CODE_TTL_SECONDS,
    resendAfterSeconds: method === 'email' ? RESEND_AFTER_SECONDS : null,
    notification: method === 'email'
      ? { title: 'New device sign-in code sent', message: `Someone entered your password on a device we don't recognize${deviceLabel ? ` (${deviceLabel})` : ''}, so we emailed you a code. Nothing happens without it. If this wasn't you, change your password.` }
      : { title: 'New device sign-in', message: `Someone entered your password on a device we don't recognize${deviceLabel ? ` (${deviceLabel})` : ''} and was asked for your app passcode. If this wasn't you, change your password.` },
  };
}

async function loadChallenge(sql, challengeId, fingerprint) {
  if (!challengeId || typeof challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(challengeId)) {
    throw new DeviceCheckError(400, 'This sign-in check has ended. Please sign in again.', { restart: true });
  }
  const rows = await sql`SELECT * FROM login_challenges WHERE id = ${challengeId} LIMIT 1`;
  const ch = rows[0];
  if (!ch || ch.fingerprint !== fingerprint) throw new DeviceCheckError(400, 'This sign-in check has ended. Please sign in again.', { restart: true });
  if (ch.used_at) throw new DeviceCheckError(400, 'This code has already been used. Please sign in again.', { restart: true });
  if (new Date(ch.expires_at).getTime() <= Date.now()) throw new DeviceCheckError(400, 'This code has expired. Please sign in again to get a new one.', { restart: true });
  if (Number(ch.attempts) >= MAX_ATTEMPTS) throw new DeviceCheckError(429, 'Too many incorrect codes. Please sign in again.', { restart: true });
  return ch;
}

// Returns the user id once the code (or passcode) is right. compareSecret is
// bcrypt.compare, passed in so this stays easy to test.
async function verifyDeviceCheck(sql, { challengeId, code, fingerprint, compareSecret }) {
  await ensureDeviceCheckSchema(sql);
  const entered = String(code || '').replace(/\s/g, '');
  const ch = await loadChallenge(sql, challengeId, fingerprint);
  if (ch.method === 'email' && !/^\d{6}$/.test(entered)) throw new DeviceCheckError(400, 'Enter the 6-digit code from the email.');
  if (ch.method === 'passcode' && !/^\d{4,6}$/.test(entered)) throw new DeviceCheckError(400, 'Enter your app passcode.');

  // Count the try first, atomically, so parallel guesses can't slip past the limit.
  const counted = await sql`
    UPDATE login_challenges SET attempts = attempts + 1
    WHERE id = ${ch.id} AND used_at IS NULL AND attempts < ${MAX_ATTEMPTS} AND expires_at > NOW()
    RETURNING attempts, code_hash
  `;
  if (!counted.length) throw new DeviceCheckError(429, 'Too many incorrect codes. Please sign in again.', { restart: true });
  const attempts = Number(counted[0].attempts);

  let ok = false;
  if (ch.method === 'email') {
    ok = sameHash(hashCode(ch.id, entered), counted[0].code_hash);
  } else {
    const u = await sql`SELECT passcode_hash FROM users WHERE id = ${ch.user_id} LIMIT 1`;
    ok = !!(u.length && u[0].passcode_hash) && await compareSecret(entered, u[0].passcode_hash);
  }
  if (!ok) {
    const left = MAX_ATTEMPTS - attempts;
    if (left <= 0) throw new DeviceCheckError(429, 'Too many incorrect codes. Please sign in again.', { restart: true });
    throw new DeviceCheckError(401, `${ch.method === 'email' ? "That code isn't right" : "That passcode isn't right"}. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { attemptsLeft: left });
  }

  const used = await sql`UPDATE login_challenges SET used_at = NOW() WHERE id = ${ch.id} AND used_at IS NULL RETURNING user_id`;
  if (!used.length) throw new DeviceCheckError(400, 'This code has already been used. Please sign in again.', { restart: true });
  return { userId: Number(used[0].user_id), method: ch.method };
}

async function resendDeviceCode(sql, { challengeId, fingerprint, sendEmail, userEmail, deviceLabel, location }) {
  await ensureDeviceCheckSchema(sql);
  const ch = await loadChallenge(sql, challengeId, fingerprint);
  if (ch.method !== 'email') throw new DeviceCheckError(400, 'Use your app passcode to finish signing in.');
  if (Number(ch.resends) >= MAX_RESENDS) throw new DeviceCheckError(429, "We've sent the most codes we can for this sign-in. Please sign in again.", { restart: true });
  const wait = Math.ceil((new Date(ch.last_sent_at).getTime() + RESEND_AFTER_SECONDS * 1000 - Date.now()) / 1000);
  if (wait > 0) throw new DeviceCheckError(429, `You can ask for a new code in ${wait} seconds.`, { retryAfterSeconds: wait });

  // Send first, then swap in the new code, so a failed email never throws
  // away the code the customer already has.
  const code = newCode();
  const sent = await sendEmail({ to: userEmail, subject: `${code} is your Apex Horizon sign-in code`, html: codeEmailHtml(code, { deviceLabel, location }) });
  if (!sent) throw new DeviceCheckError(502, "We couldn't send a new code just now. Your last code still works, or try again in a moment.");
  const claimed = await sql`
    UPDATE login_challenges
    SET code_hash = ${hashCode(ch.id, code)}, resends = resends + 1, last_sent_at = NOW(),
        expires_at = GREATEST(expires_at, NOW() + INTERVAL '10 minutes')
    WHERE id = ${ch.id} AND used_at IS NULL AND resends = ${Number(ch.resends)}
    RETURNING resends
  `;
  if (!claimed.length) throw new DeviceCheckError(429, 'A new code is already on its way.');
  return { resendsLeft: MAX_RESENDS - Number(claimed[0].resends), resendAfterSeconds: RESEND_AFTER_SECONDS };
}

module.exports = {
  DeviceCheckError,
  ensureDeviceCheckSchema,
  needsDeviceCheck,
  isDemoAccount,
  startDeviceCheck,
  verifyDeviceCheck,
  resendDeviceCode,
  maskEmail,
  codeEmailHtml,
  MAX_ATTEMPTS,
  MAX_RESENDS,
  RESEND_AFTER_SECONDS,
  MAX_CHECKS_PER_HOUR,
};
