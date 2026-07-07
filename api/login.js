const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail, signToken, setSessionCookie } = require('./auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, password } = req.body || {};

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

    const token = signToken({ userId: user.id, email: user.email });
    setSessionCookie(res, token);

    return res.status(200).json({
      user: { id: user.id, email: user.email, fullName: user.full_name },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
