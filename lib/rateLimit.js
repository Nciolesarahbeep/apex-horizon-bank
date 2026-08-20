const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Checks whether login attempts for this email or IP have exceeded the
 * threshold in the last WINDOW_MINUTES. Returns { blocked, retryAfterSeconds }.
 */
async function checkLoginRateLimit(sql, { email, ip }) {
  const rows = await sql`
    SELECT created_at FROM login_attempts
    WHERE success = false
      AND created_at > NOW() - make_interval(mins => ${WINDOW_MINUTES})
      AND (email = ${email} OR ip = ${ip})
    ORDER BY created_at ASC
  `;

  if (rows.length < MAX_ATTEMPTS) {
    return { blocked: false };
  }

  // Oldest of the "excess" attempts determines when the window clears.
  const oldestRelevant = rows[rows.length - MAX_ATTEMPTS].created_at;
  const unlockAt = new Date(new Date(oldestRelevant).getTime() + WINDOW_MINUTES * 60 * 1000);
  const retryAfterSeconds = Math.max(1, Math.ceil((unlockAt.getTime() - Date.now()) / 1000));

  return { blocked: true, retryAfterSeconds };
}

async function recordLoginAttempt(sql, { email, ip, success }) {
  await sql`
    INSERT INTO login_attempts (email, ip, success)
    VALUES (${email}, ${ip}, ${success})
  `;
}

/**
 * Optional cleanup so the table doesn't grow forever. Safe to call
 * occasionally (e.g. on a fraction of login requests) rather than every time.
 */
async function pruneOldAttempts(sql) {
  await sql`
    DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '1 day'
  `;
}

module.exports = { getClientIp, checkLoginRateLimit, recordLoginAttempt, pruneOldAttempts };
