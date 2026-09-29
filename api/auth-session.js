const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const {
  normalizeEmail, signToken, setSessionCookie, clearSessionCookie,
  createSession, revokeSessionByJti, decodeTokenUnsafe, parseCookies, COOKIE_NAME,
} = require('../lib/auth');
const { logSignInActivity, getPreviousSignIn, describeDevice } = require('../lib/loginActivity');
const { getClientIp, checkLoginRateLimit, recordLoginAttempt, pruneOldAttempts } = require('../lib/rateLimit');
const { isKnownDevice, recordKnownDevice, fingerprintFromRequest } = require('../lib/fraud');
const { sendEmail } = require('../lib/email');
const deviceCheck = require('../lib/deviceCheck');
const deviceTrust = require('../lib/deviceTrust');


const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const { withPush } = require('../lib/push');

// Same device fingerprint lib/fraud.js uses for the known-device list.
const deviceFingerprint = (req) => fingerprintFromRequest(req);

// The long-lived "this device" cookie lives in lib/deviceTrust.js (Face ID
// sign-in sets it too). These wrappers keep the call sites below short.
const knownByDeviceCookie = (userId, req) => deviceTrust.knownByDeviceCookie(sql, userId, req);
const rememberThisDevice = (req, res, userId) => deviceTrust.rememberThisDevice(sql, req, res, userId);

// Rough location from Vercel's edge headers (no extra lookup), e.g. "Lagos, NG".
function edgeLocation(req) {
  const h = req.headers || {};
  let city = '';
  try { city = decodeURIComponent(String(h['x-vercel-ip-city'] || '')); } catch (e) { city = ''; }
  return [city, String(h['x-vercel-ip-country'] || '')].filter(Boolean).join(', ') || null;
}

// Everything that happens once we're sure it's them: remember the device,
// start the session, log the sign-in and answer with the welcome details.
async function completeSignIn({ req, res, user, known, method, verifiedWith }) {
  if (!known) await recordKnownDevice({ userId: user.id, req });
  const updatedRows = await sql`
    UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}
    RETURNING last_login_at
  `;
  const jti = await createSession(user.id, req);
  const token = signToken({ userId: user.id, email: user.email, jti });
  setSessionCookie(res, token);
  await rememberThisDevice(req, res, user.id);
  // The sign-in before this one, for the "last signed in" line on the welcome screen.
  const previousSignIn = await getPreviousSignIn(user.id);
  // Only surface an in-app "new device" notification when the device was unknown.
  await logSignInActivity({ req, userId: user.id, email: user.email, method, isNewDevice: !known });
  return res.status(200).json({
    user: { id: user.id, email: user.email, fullName: user.full_name, lastLoginAt: updatedRows[0].last_login_at },
    previousSignIn,
    newDevice: !known,
    verifiedWith: verifiedWith || null,
  });
}

async function notify(userId, title, message) {
  try {
    await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at) VALUES (${userId}, ${title}, ${message}, FALSE, NOW())`;
  } catch (err) {
    console.error('Notification error (non-fatal):', err);
  }
}

module.exports = withPush(async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  if (action === 'logout') {
    try {
      const cookies = parseCookies(req);
      const token = cookies[COOKIE_NAME];
      if (token) {
        const decoded = decodeTokenUnsafe(token);
        if (decoded && decoded.jti && decoded.userId) {
          await revokeSessionByJti(decoded.jti, decoded.userId);
        }
      }
    } catch (err) {
      // Never block logout on a revocation hiccup — the cookie is cleared regardless.
      console.error('Session revoke on logout error (non-fatal):', err);
    }

    clearSessionCookie(res);
    return res.status(200).json({ success: true });
  }

  if (action === 'login') {
    const ip = getClientIp(req);
    let normalizedEmail = null;

    try {
      const { email, password } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      normalizedEmail = normalizeEmail(email);

      // --- Rate limit check, before touching the password hash at all ---
      const rateLimit = await checkLoginRateLimit(sql, { email: normalizedEmail, ip });
      if (rateLimit.blocked) {
        res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
        const minutes = Math.ceil(rateLimit.retryAfterSeconds / 60);
        return res.status(429).json({
          error: `Too many failed login attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        });
      }

      const result = await sql`
        SELECT id, email, password_hash, passcode_hash, full_name, is_active, approval_status, approval_reason
        FROM users
        WHERE email = ${normalizedEmail}
        LIMIT 1
      `;

      if (result.length === 0) {
        await recordLoginAttempt(sql, { email: normalizedEmail, ip, success: false });
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result[0];
      const passwordMatches = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatches) {
        await recordLoginAttempt(sql, { email: normalizedEmail, ip, success: false });
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      // Approval gate — checked before is_active, since a never-approved
      // account was never "active" to begin with.
      if (user.approval_status === 'pending') {
        return res.status(403).json({
          error: 'Your account is still under review. We\'ll notify you by email once a decision is made.',
          approvalStatus: 'pending',
        });
      }
      if (user.approval_status === 'rejected') {
        return res.status(403).json({
          error: user.approval_reason
            ? `Your account application was not approved: ${user.approval_reason}`
            : 'Your account application was not approved. Please contact support for details.',
          approvalStatus: 'rejected',
        });
      }

      if (!user.is_active) {
        return res.status(403).json({ error: 'This account has been disabled. Please contact support.' });
      }

      // Successful, legitimate login — clear the slate for this email/IP.
      await recordLoginAttempt(sql, { email: normalizedEmail, ip, success: true });

      // Cheap, non-blocking cleanup so login_attempts doesn't grow forever.
      // Fired roughly 1 in 20 logins — never awaited, never blocks the response.
      if (Math.random() < 0.05) {
        pruneOldAttempts(sql).catch((err) => console.error('Prune login_attempts error (non-fatal):', err));
      }

      // A device we haven't seen before (and not the account's first ever)
      // has to prove it's them with a code we email before any session exists.
      const deviceInfo = await isKnownDevice({ userId: user.id, req });
      const known = deviceInfo.known || await knownByDeviceCookie(user.id, req);
      const isFirstDeviceEver = deviceInfo.isFirstDeviceEver;
      if (deviceCheck.needsDeviceCheck({ email: user.email, known, isFirstDeviceEver })) {
        const check = await deviceCheck.startDeviceCheck(sql, {
          user,
          fingerprint: deviceFingerprint(req),
          sendEmail,
          deviceLabel: describeDevice(req.headers['user-agent']),
          location: edgeLocation(req),
        });
        if (check.method) {
          await notify(user.id, check.notification.title, check.notification.message);
          return res.status(200).json({
            verificationRequired: true,
            challengeId: check.challengeId,
            method: check.method,
            destination: check.destination,
            expiresInSeconds: check.expiresInSeconds,
            resendAfterSeconds: check.resendAfterSeconds,
            firstName: String(user.full_name || '').trim().split(/\s+/)[0] || null,
          });
        }
        // No way to send a code and no passcode to fall back on: let them in
        // with the usual new-device alert rather than locking them out.
        console.error(`Device check skipped for user ${user.id}: code email could not be sent and no passcode is set.`);
      }

      return await completeSignIn({ req, res, user, known, method: 'password' });
    } catch (err) {
      if (err instanceof deviceCheck.DeviceCheckError) return res.status(err.status).json({ error: err.message });
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  // Unlock with the app passcode, like a bank app's PIN. Only on a device
  // this account has already signed in on (it carries the "this device"
  // cookie), and wrong passcodes count toward the same lockout as wrong
  // passwords, so a 4-6 digit code can't be guessed from anywhere else.
  if (action === 'login-passcode') {
    const ip = getClientIp(req);
    try {
      const { email, passcode } = req.body || {};
      if (!email || !passcode) {
        return res.status(400).json({ error: 'Enter your passcode.' });
      }
      if (!/^\d{4,6}$/.test(String(passcode))) {
        return res.status(400).json({ error: 'Your passcode is 4 to 6 digits.' });
      }
      const normalizedEmail = normalizeEmail(email);

      const rateLimit = await checkLoginRateLimit(sql, { email: normalizedEmail, ip });
      if (rateLimit.blocked) {
        res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
        const minutes = Math.ceil(rateLimit.retryAfterSeconds / 60);
        return res.status(429).json({
          error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or use Face ID.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        });
      }

      const rows = await sql`
        SELECT id, email, passcode_hash, full_name, is_active, approval_status, approval_reason
        FROM users WHERE email = ${normalizedEmail} LIMIT 1
      `;
      const user = rows[0];
      // Same answer for "no such account" and "not a device you've used",
      // so this can't be used to find out who banks with Apex.
      const trusted = user ? await knownByDeviceCookie(user.id, req) : false;
      if (!user || !trusted) {
        return res.status(403).json({ error: "Passcode unlock only works on a phone you've signed in on before. Use your password.", usePassword: true });
      }
      if (!user.passcode_hash) {
        return res.status(400).json({ error: "You haven't set up an app passcode yet. Sign in with your password, then create one in Settings.", noPasscode: true });
      }

      const ok = await bcrypt.compare(String(passcode), user.passcode_hash);
      if (!ok) {
        await recordLoginAttempt(sql, { email: normalizedEmail, ip, success: false });
        const after = await checkLoginRateLimit(sql, { email: normalizedEmail, ip });
        if (after.blocked) {
          const minutes = Math.ceil(after.retryAfterSeconds / 60);
          return res.status(429).json({
            error: `Too many incorrect attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or use Face ID.`,
            retryAfterSeconds: after.retryAfterSeconds,
          });
        }
        return res.status(401).json({ error: 'Incorrect passcode. Try again.' });
      }

      if (user.approval_status === 'pending') {
        return res.status(403).json({ error: "Your account is still under review. We'll notify you by email once a decision is made.", approvalStatus: 'pending' });
      }
      if (user.approval_status === 'rejected') {
        return res.status(403).json({
          error: user.approval_reason
            ? `Your account application was not approved: ${user.approval_reason}`
            : 'Your account application was not approved. Please contact support for details.',
          approvalStatus: 'rejected',
        });
      }
      if (!user.is_active) {
        return res.status(403).json({ error: 'This account has been disabled. Please contact support.' });
      }

      await recordLoginAttempt(sql, { email: normalizedEmail, ip, success: true });
      return await completeSignIn({ req, res, user, known: true, method: 'passcode' });
    } catch (err) {
      console.error('Passcode sign-in error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  // Finish a new-device sign-in with the emailed code (or the app passcode).
  if (action === 'verify-device') {
    try {
      const { challengeId, code } = req.body || {};
      const verified = await deviceCheck.verifyDeviceCheck(sql, {
        challengeId,
        code,
        fingerprint: deviceFingerprint(req),
        compareSecret: (plain, hash) => bcrypt.compare(plain, hash),
      });
      const rows = await sql`SELECT id, email, full_name, is_active, approval_status FROM users WHERE id = ${verified.userId} LIMIT 1`;
      const user = rows[0];
      if (!user || !user.is_active || user.approval_status === 'pending' || user.approval_status === 'rejected') {
        return res.status(403).json({ error: 'This account cannot sign in right now. Please contact support.' });
      }
      return await completeSignIn({ req, res, user, known: false, method: 'password', verifiedWith: verified.method });
    } catch (err) {
      if (err instanceof deviceCheck.DeviceCheckError) {
        return res.status(err.status).json({ error: err.message, restart: !!err.restart, attemptsLeft: err.attemptsLeft });
      }
      console.error('Verify device error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  if (action === 'resend-device-code') {
    try {
      const { challengeId } = req.body || {};
      const chRows = await sql`SELECT user_id FROM login_challenges WHERE id = ${String(challengeId || '')} LIMIT 1`.catch(() => []);
      const userRows = chRows.length ? await sql`SELECT email FROM users WHERE id = ${chRows[0].user_id} LIMIT 1` : [];
      const result = await deviceCheck.resendDeviceCode(sql, {
        challengeId,
        fingerprint: deviceFingerprint(req),
        sendEmail,
        userEmail: userRows.length ? userRows[0].email : null,
        deviceLabel: describeDevice(req.headers['user-agent']),
        location: edgeLocation(req),
      });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      if (err instanceof deviceCheck.DeviceCheckError) {
        return res.status(err.status).json({ error: err.message, restart: !!err.restart, retryAfterSeconds: err.retryAfterSeconds });
      }
      console.error('Resend device code error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "login", "login-passcode", "verify-device", "resend-device-code" or "logout".' });
}, sql);
