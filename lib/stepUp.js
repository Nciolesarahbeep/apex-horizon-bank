// Step-up confirmation for large money movements.
//
// When a customer sends money at or above their confirmation threshold, the
// server refuses the request with { stepUpRequired: true } until the app sends
// a fresh step-up token. The app gets that token by confirming with Face ID
// (api/webauthn-register.js, action "stepup-verify") or with the app passcode
// / password (api/account-services.js, resource "step-up").
//
// Tokens are signed, expire after 5 minutes, are tied to the signed-in session,
// cover a maximum amount, and can be used exactly once. A token asked for to
// see card details only works for that, and a payment token can't show card
// details, so confirming one thing never quietly approves another.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'apex-horizon-dev-secret-change-in-prod';
const TOKEN_TTL_SECONDS = 5 * 60;
const DEFAULT_THRESHOLD = 1000;
const MIN_THRESHOLD = 50;
const MAX_THRESHOLD = 25000;

async function ensureStepUpSchema(sql) {
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_threshold NUMERIC(14,2) NOT NULL DEFAULT 1000`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_use_face_id BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_failed_attempts INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS step_up_locked_until TIMESTAMPTZ`;
  await sql`
    CREATE TABLE IF NOT EXISTS step_up_token_uses (
      nonce TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

async function getStepUpSettings(sql, userId) {
  await ensureStepUpSchema(sql);
  const rows = await sql`
    SELECT step_up_enabled, step_up_threshold, step_up_use_face_id,
           passcode_hash IS NOT NULL AS has_passcode
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  const u = rows[0] || {};
  return {
    enabled: u.step_up_enabled !== false,
    threshold: u.step_up_threshold != null ? Number(u.step_up_threshold) : DEFAULT_THRESHOLD,
    useFaceId: u.step_up_use_face_id !== false,
    hasPasscode: u.has_passcode === true,
  };
}

async function saveStepUpSettings(sql, userId, { enabled, threshold, useFaceId }) {
  await ensureStepUpSchema(sql);
  const t = Number(threshold);
  if (!Number.isFinite(t) || t < MIN_THRESHOLD || t > MAX_THRESHOLD) {
    const err = new Error(`Choose an amount between $${MIN_THRESHOLD} and $${MAX_THRESHOLD.toLocaleString()}.`);
    err.status = 400;
    throw err;
  }
  await sql`
    UPDATE users
    SET step_up_enabled = ${Boolean(enabled)},
        step_up_threshold = ${Math.round(t * 100) / 100},
        step_up_use_face_id = ${useFaceId !== false}
    WHERE id = ${userId}
  `;
  return getStepUpSettings(sql, userId);
}

function stepUpScope(scope) {
  return scope === 'card-details' ? 'card-details' : 'money';
}

function issueStepUpToken({ userId, jti, method, maxAmount, scope }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { t: 'stepup', sub: String(userId), sid: jti || null, m: method, max: Number(maxAmount) || null, n: nonce, s: stepUpScope(scope) },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS }
  );
  return { token, expiresInSeconds: TOKEN_TTL_SECONDS };
}

// Call right before moving money. Returns true when the request may continue;
// otherwise it has already sent the 403 response and returns false.
// always: true asks every time, whatever the transfer threshold is (used for
// showing full card details).
async function requireStepUp(sql, { req, res, session, amount, reason = 'transfer', always = false }) {
  const settings = await getStepUpSettings(sql, session.userId);
  const value = Number(amount) || 0;
  if (!always && (!settings.enabled || !(value >= settings.threshold))) return true;

  const token = (req.body || {}).stepUpToken;
  if (token) {
    try {
      const claims = jwt.verify(token, JWT_SECRET);
      const sameUser = claims.t === 'stepup' && claims.sub === String(session.userId);
      const sameSession = !claims.sid || !session.jti || claims.sid === session.jti;
      const coversAmount = claims.max == null || value <= Number(claims.max) + 0.001;
      const rightScope = stepUpScope(claims.s) === stepUpScope(reason);
      if (sameUser && sameSession && coversAmount && rightScope) {
        const used = await sql`
          INSERT INTO step_up_token_uses (nonce, user_id) VALUES (${claims.n}, ${session.userId})
          ON CONFLICT (nonce) DO NOTHING
          RETURNING nonce
        `;
        if (used.length > 0) {
          // Opportunistic cleanup of old nonces.
          if (Math.random() < 0.05) {
            sql`DELETE FROM step_up_token_uses WHERE used_at < NOW() - INTERVAL '1 day'`.catch(() => {});
          }
          return true;
        }
      }
    } catch (err) {
      // Expired or tampered token: fall through and ask again.
    }
  }

  res.status(403).json({
    error: reason === 'settings'
      ? 'Please confirm it\'s you with Face ID or your passcode to change this security setting.'
      : reason === 'card-details'
      ? 'Please confirm it\'s you with Face ID or your passcode to see your card details.'
      : `Please confirm transfers of $${settings.threshold.toLocaleString('en-US')} or more with Face ID or your passcode.`,
    reason,
    stepUpRequired: true,
    amount: value,
    threshold: settings.threshold,
    useFaceId: settings.useFaceId,
    hasPasscode: settings.hasPasscode,
  });
  return false;
}

module.exports = {
  ensureStepUpSchema,
  getStepUpSettings,
  saveStepUpSettings,
  issueStepUpToken,
  requireStepUp,
  stepUpScope,
  MIN_THRESHOLD,
  MAX_THRESHOLD,
};
