const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail, signToken, setSessionCookie, clearSessionCookie } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  if (action === 'logout') {
    clearSessionCookie(res);
    return res.status(200).json({ success: true });
  }

  if (action === 'login') {
    try {
      const { email, password, rememberDevice } = req.body || {};

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const normalizedEmail = normalizeEmail(email);

      const result = await sql`
        SELECT id, email, password_hash, full_name
        FROM users
        WHERE email = ${normalizedEmail}
        LIMIT 1
      `;

      if (result.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = result[0];
      const passwordMatches = await bcrypt.compare(password, user.password_hash);

      if (!passwordMatches) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const updatedRows = await sql`
        UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}
        RETURNING last_login_at
      `;

      const token = signToken({ userId: user.id, email: user.email });
      // Default to true if the field is missing entirely, so older clients
      // that don't send it yet keep the previous "always remembered" behavior.
      setSessionCookie(res, token, rememberDevice !== false);

      return res.status(200).json({
        user: { id: user.id, email: user.email, fullName: user.full_name, lastLoginAt: updatedRows[0].last_login_at },
      });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "login" or "logout".' });
};
