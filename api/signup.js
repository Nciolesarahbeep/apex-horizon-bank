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
    const { email, password, fullName } = req.body || {};

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    const normalizedEmail = normalizeEmail(email);

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    // 10 salt rounds — same cost factor MUST be used implicitly by bcrypt.compare in login.js
    const passwordHash = await bcrypt.hash(password, 10);

    const userResult = await sql`
      INSERT INTO users (email, password_hash, full_name, created_at)
      VALUES (${normalizedEmail}, ${passwordHash}, ${fullName}, NOW())
      RETURNING id, email, full_name
    `;
    const user = userResult[0];

    // Seed a checking and savings account for the new user
    await sql`
      INSERT INTO accounts (user_id, account_type, balance)
      VALUES
        (${user.id}, 'checking', 5000.00),
        (${user.id}, 'savings', 12500.00)
    `;

    const token = signToken({ userId: user.id, email: user.email });
    setSessionCookie(res, token);

    return res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.full_name },
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
};
