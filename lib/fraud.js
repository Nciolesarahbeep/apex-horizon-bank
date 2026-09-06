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

// Flags a login from a device/browser fingerprint never seen before for this
// user. Skips a user's very first-ever login (nothing to compare against yet,
// so it's not suspicious). Best-effort — never throws.
async function flagNewDeviceLogin({ userId, req }) {
  try {
    const userAgent = (req.headers && req.headers['user-agent']) || 'unknown';
    const fingerprint = crypto.createHash('sha256').update(userAgent).digest('hex').slice(0, 32);

    const existing = await sql`
      SELECT id FROM known_devices WHERE user_id = ${userId} AND device_fingerprint = ${fingerprint} LIMIT 1
    `;
    if (existing.length > 0) return; // already a known device

    const priorCountRows = await sql`SELECT COUNT(*)::int AS count FROM known_devices WHERE user_id = ${userId}`;
    const isFirstDeviceEver = priorCountRows[0].count === 0;

    await sql`
      INSERT INTO known_devices (user_id, device_fingerprint, user_agent)
      VALUES (${userId}, ${fingerprint}, ${userAgent})
      ON CONFLICT (user_id, device_fingerprint) DO NOTHING
    `;

    if (isFirstDeviceEver) return; // first login ever — not suspicious

    await sql`
      INSERT INTO fraud_flags (user_id, flag_type, severity, details, created_at)
      VALUES (
        ${userId}, 'new_device_login', 'medium',
        ${`Login from a device or browser we haven't seen before: ${userAgent}`},
        NOW()
      )
    `;

    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (
        ${userId}, 'New Device Sign-In',
        'We noticed a sign-in from a device we haven''t seen before. If this wasn''t you, please secure your account immediately.',
        FALSE, NOW()
      )
    `;
  } catch (err) {
    console.error('flagNewDeviceLogin error (non-fatal):', err);
  }
}

module.exports = { flagLargeTransfer, flagNewDeviceLogin, LARGE_TRANSFER_THRESHOLD };
