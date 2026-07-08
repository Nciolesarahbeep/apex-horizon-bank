const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const normalizedEmail = normalizeEmail(email);

    const userRows = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;

    const genericResponse = {
      success: true,
      message: 'If an account exists for that email, a reset link has been generated.',
    };

    if (userRows.length === 0) {
      return res.status(200).json(genericResponse);
    }

    const user = userRows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    await sql`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()})
    `;

    return res.status(200).json({
      ...genericResponse,
      demoResetToken: rawToken,
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
