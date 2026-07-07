const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, newPassword } = req.body || {};

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const resetRows = await sql`
      SELECT id, user_id, expires_at, used
      FROM password_resets
      WHERE token_hash = ${tokenHash}
      LIMIT 1
    `;

    if (resetRows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const resetRow = resetRows[0];

    if (resetRow.used) {
      return res.status(400).json({ error: 'This reset link has already been used. Please request a new one.' });
    }
    if (new Date(resetRow.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${resetRow.user_id}`;
    await sql`UPDATE password_resets SET used = TRUE WHERE id = ${resetRow.id}`;

    return res.status(200).json({ success: true, message: 'Password updated. You can now sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
