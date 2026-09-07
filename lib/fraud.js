const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

const LARGE_TRANSFER_THRESHOLD = 5000;

// Flags any transfer at or above the threshold. Best-effort — never throws,
// so a fraud-detection hiccup can never block or fail the underlying transfer.
async function flagLargeTransfer({ userId, amount, transactionId, transferType }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < LARGE_TRANSFER_THRESHOLD) return;

  try {
    const severity = amt >= LARGE_TRANSFER_THRESHOLD * 2 ? 'high' : 'medium';
    const amountFormatted = amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    await sql`
      INSERT INTO fraud_flags (user_id, flag_type, severity, details, related_transaction_id, created_at)
      VALUES (
        ${userId}, 'large_transfer', ${severity},
        ${`A ${transferType} transfer of $${amountFormatted} exceeded the $${LARGE_TRANSFER_THRESHOLD.toLocaleString()} threshold.`},
        ${transactionId || null}, NOW()
      )
    `;

    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (
        ${userId}, 'Large Transfer Alert',
        ${`We flagged your recent $${amountFormatted} transfer for review as a security precaution. If this wasn't you, contact support immediately.`},
        FALSE, NOW()
      )
    `;
  } catch (err) {
    console.error('flagLargeTransfer error (non-fatal):', err);
  }
}

function fingerprintFromRequest(req) {
  const userAgent = (req.headers && req.headers['user-agent']) || 'unknown';
  return crypto.createHash('sha256').update(userAgent).digest('hex').slice(0, 32);
}

// Read-only check — does NOT record anything. Call this at login time,
// before deciding whether to gate the session behind OTP.
async function isKnownDevice({ userId, req }) {
  const fingerprint = fingerprintFromRequest(req);

  const existing = await sql`
    SELECT id FROM known_devices WHERE user_id = ${userId} AND device_fingerprint = ${fingerprint} LIMIT 1
  `;
  const known = existing.length > 0;

  const priorCountRows = await sql`SELECT COUNT(*)::int AS count FROM known_devices WHERE user_id = ${userId}`;
  const isFirstDeviceEver = priorCountRows[0].count === 0;

  return { known, fingerprint, isFirstDeviceEver };
}

// Actually commits a device as "known" — call this only once a login from
// that device has been fully verified (either it was the user's very first
// device ever, or they just passed the OTP challenge for it).
async function recordKnownDevice({ userId, req }) {
  try {
    const userAgent = (req.headers && req.headers['user-agent']) || 'unknown';
    const fingerprint = fingerprintFromRequest(req);

    await sql`
      INSERT INTO known_devices (user_id, device_fingerprint, user_agent)
      VALUES (${userId}, ${fingerprint}, ${userAgent})
      ON CONFLICT (user_id, device_fingerprint) DO NOTHING
    `;
  } catch (err) {
    console.error('recordKnownDevice error (non-fatal):', err);
  }
}

// Creates the fraud_flags entry + user notification for a detected new-device
// login. Call this at detection time (before OTP is even sent) — it's the
// detection itself that's noteworthy for admin visibility, regardless of
// whether the user goes on to pass the OTP challenge.
async function flagNewDeviceLogin({ userId, req, fingerprint }) {
  try {
    const userAgent = (req.headers && req.headers['user-agent']) || 'unknown';

    await sql`
      INSERT INTO fraud_flags (user_id, flag_type, severity, details, created_at)
      VALUES (
        ${userId}, 'new_device_login', 'medium',
        ${`Login attempt from a device or browser we haven't seen before: ${userAgent}`},
        NOW()
      )
    `;

    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (
        ${userId}, 'New Device Sign-In',
        'We noticed a sign-in attempt from a device we haven''t seen before and sent a verification code to your email. If this wasn''t you, you can safely ignore it — access is blocked until the code is entered.',
        FALSE, NOW()
      )
    `;
  } catch (err) {
    console.error('flagNewDeviceLogin error (non-fatal):', err);
  }
}

module.exports = {
  flagLargeTransfer,
  isKnownDevice,
  recordKnownDevice,
  flagNewDeviceLogin,
  LARGE_TRANSFER_THRESHOLD,
};
