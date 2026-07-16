const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail, signToken, setSessionCookie } = require('../lib/auth');
const { sendEmail, welcomeEmailHtml } = require('../lib/email');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Generates a realistic 10-digit US-style account number and guarantees
// it's not already in use before handing it back.
async function generateUniqueAccountNumber() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const existing = await sql`SELECT id FROM accounts WHERE account_number = ${candidate} LIMIT 1`;
    if (existing.length === 0) return candidate;
  }
  throw new Error('Could not generate a unique account number after several attempts.');
}

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

    // Real, unique account numbers — the checking one is the P2P gateway.
    const checkingAccountNumber = await generateUniqueAccountNumber();
    const savingsAccountNumber = await generateUniqueAccountNumber();

    await sql`
      INSERT INTO accounts (user_id, account_type, balance, account_number)
      VALUES
        (${user.id}, 'checking', 5000.00, ${checkingAccountNumber}),
        (${user.id}, 'savings', 12500.00, ${savingsAccountNumber})
    `;

    // Welcome notification (in-app bell) — best-effort, never blocks signup
    try {
      await sql`
        INSERT INTO notifications (user_id, title, message)
        VALUES (${user.id}, 'Welcome to Apex Horizon Bank', ${'Your account has been created successfully, ' + user.full_name + '. Your account number is ' + checkingAccountNumber + '.'})
      `;
    } catch (notifyErr) {
      console.error('Welcome notification insert error (non-fatal):', notifyErr);
    }

    // Welcome email — best-effort, never blocks signup
    await sendEmail({
      to: user.email,
      subject: 'Welcome to Apex Horizon Bank',
      html: welcomeEmailHtml(user.full_name, checkingAccountNumber),
    });

    const token = signToken({ userId: user.id, email: user.email });
    setSessionCookie(res, token);

    return res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.full_name },
      accountNumber: checkingAccountNumber,
    });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
};
