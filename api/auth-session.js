const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const {
  normalizeEmail, signToken, setSessionCookie, clearSessionCookie,
  createSession, revokeSessionByJti, decodeTokenUnsafe, parseCookies, COOKIE_NAME,
} = require('../lib/auth');
const { logSignInActivity } = require('../lib/loginActivity');
const { getClientIp, checkLoginRateLimit, recordLoginAttempt, pruneOldAttempts } = require('../lib/rateLimit');
const { flagNewDeviceLogin, isKnownDevice, recordKnownDevice } = require('../lib/fraud');
const { generateAndSendLoginOtp, verifyLoginOtp } = require('../lib/otp');


const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
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

  if (action === 'verify-login-otp') {
    try {
      const { pendingToken, code } = req.body || {};
      const result = await verifyLoginOtp({ pendingToken, code });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const userRows = await sql`
        SELECT id, email, full_name, is_active FROM users WHERE id = ${result.userId} LIMIT 1
      `;
      if (userRows.length === 0 || !userRows[0].is_active) {
        return res.status(403).json({ error: 'This account is not available. Please contact support.' });
      }
      const user = userRows[0];

      await recordKnownDevice({ userId: user.id, req });

      const updatedRows = await sql`
        UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}
        RETURNING last_login_at
      `;

      const jti = await createSession(user.id, req);
      const token = signToken({ userId: user.id, email: user.email, jti });
      setSessionCookie(res, token);

      await logSignInActivity({ req, userId: user.id, email: user.email, method: 'password' });

      return res.status(200).json({
        user: { id: user.id, email: user.email, fullName: user.full_name, lastLoginAt: updatedRows[0].last_login_at },
      });
    } catch (err) {
      console.error('OTP verification error:', err);
      return res.status(500).json({ error: 'Something went wrong verifying your code. Please try again.' });
    }
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
        SELECT id, email, password_hash, full_name, is_active, approval_status, approval_reason
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

      // ---------- Fraud check: gate never-seen-before devices behind an email OTP ----------
      const { known, fingerprint, isFirstDeviceEver } = await isKnownDevice({ userId: user.id, req });

      if (!known && !isFirstDeviceEver) {
        await flagNewDeviceLogin({ userId: user.id, req, fingerprint });
        const pendingToken = await generateAndSendLoginOtp({ userId: user.id, email: user.email, fingerprint });
        return res.status(200).json({
          requiresOtp: true,
          pendingToken,
          message: 'We sent a verification code to your email to confirm this new device.',
        });
      }

      if (!known) {
        // First device ever for this account — nothing to compare against, not suspicious.
        await recordKnownDevice({ userId: user.id, req });
      }

      const updatedRows = await sql`
        UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}
        RETURNING last_login_at
      `;

      const jti = await createSession(user.id, req);
      const token = signToken({ userId: user.id, email: user.email, jti });
      setSessionCookie(res, token);

      await logSignInActivity({ req, userId: user.id, email: user.email, method: 'password' });

      return res.status(200).json({
        user: { id: user.id, email: user.email, fullName: user.full_name, lastLoginAt: updatedRows[0].last_login_at },
      });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "login", "logout", or "verify-login-otp".' });
};
