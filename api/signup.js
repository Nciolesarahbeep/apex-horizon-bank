const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail, signToken, setSessionCookie } = require('../lib/auth');
const { sendEmail, welcomeEmailHtml } = require('../lib/email');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

const CODE_TTL_MINUTES = 10;

async function generateUniqueAccountNumber() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const existing = await sql`SELECT id FROM accounts WHERE account_number = ${candidate} LIMIT 1`;
    if (existing.length === 0) return candidate;
  }
  throw new Error('Could not generate a unique account number after several attempts.');
}

function verificationEmailHtml(code) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111;">
      <div style="font-size: 12px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase; color: #10b981; margin-bottom: 16px;">Apex Horizon Bank</div>
      <h2 style="color:#0f172a; font-size: 18px;">Verify Your Email</h2>
      <p>Use this code to finish creating your Apex Horizon Bank account:</p>
      <p style="margin: 24px 0; text-align: center;">
        <span style="display:inline-block; background:#0f172a; color:#fff; padding:14px 28px; border-radius:8px; font-size:28px; font-weight:bold; letter-spacing:0.3em; font-family: monospace;">${code}</span>
      </p>
      <p style="color:#666; font-size:12px;">This code expires in ${CODE_TTL_MINUTES} minutes. If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  // ---------- Step 1: send a verification code to the email ----------
  if (action === 'send-code') {
    try {
      const { email } = req.body || {};
      if (!email || !email.includes('@') || !email.includes('.')) {
        return res.status(400).json({ error: 'Enter a valid email address.' });
      }

      const normalizedEmail = normalizeEmail(email);

      const existingUser = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
      if (existingUser.length > 0) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

      // Clear any previous unverified codes for this email before issuing a new one
      await sql`DELETE FROM signup_verifications WHERE email = ${normalizedEmail}`;

      await sql`
        INSERT INTO signup_verifications (email, code, expires_at, verified)
        VALUES (${normalizedEmail}, ${code}, ${expiresAt.toISOString()}, FALSE)
      `;

      const emailSent = await sendEmail({
        to: normalizedEmail,
        subject: 'Your Apex Horizon Bank verification code',
        html: verificationEmailHtml(code),
      });

      if (!emailSent) {
        return res.status(502).json({ error: 'Could not deliver the verification email. Please try again in a moment.' });
      }

      return res.status(200).json({ success: true, message: 'Verification code sent.' });
    } catch (err) {
      console.error('Send verification code error:', err);
      return res.status(500).json({ error: 'Could not send verification code. Please try again.' });
    }
  }

  // ---------- Step 2: verify the code ----------
  if (action === 'verify-code') {
    try {
      const { email, code } = req.body || {};
      if (!email || !code) {
        return res.status(400).json({ error: 'Email and code are required.' });
      }

      const normalizedEmail = normalizeEmail(email);
      const cleanCode = String(code).trim();

      const rows = await sql`
        SELECT id, expires_at, verified FROM signup_verifications
        WHERE email = ${normalizedEmail} AND code = ${cleanCode}
        ORDER BY created_at DESC LIMIT 1
      `;

      if (rows.length === 0) {
        return res.status(400).json({ error: 'Incorrect verification code.' });
      }

      const row = rows[0];
      if (new Date(row.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This code has expired. Please request a new one.' });
      }

      await sql`UPDATE signup_verifications SET verified = TRUE WHERE id = ${row.id}`;

      return res.status(200).json({ success: true, message: 'Email verified.' });
    } catch (err) {
      console.error('Verify code error:', err);
      return res.status(500).json({ error: 'Could not verify code. Please try again.' });
    }
  }

  // ---------- Step 3: create the account (only if email was verified) ----------
  if (action === 'create-account') {
    try {
      const { email, password, fullName } = req.body || {};

      if (!email || !password || !fullName) {
        return res.status(400).json({ error: 'Full name, email, and password are required.' });
      }

      const normalizedEmail = normalizeEmail(email);

      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      }

      // Re-check verification server-side — never trust the client's word for this.
      const verifiedRows = await sql`
        SELECT id FROM signup_verifications
        WHERE email = ${normalizedEmail} AND verified = TRUE
        ORDER BY created_at DESC LIMIT 1
      `;
      if (verifiedRows.length === 0) {
        return res.status(400).json({ error: 'Please verify your email before creating an account.' });
      }

      const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
      if (existing.length > 0) {
        return res.status(409).json({ error: 'An account with that email already exists.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const userResult = await sql`
        INSERT INTO users (email, password_hash, full_name, created_at, last_login_at)
        VALUES (${normalizedEmail}, ${passwordHash}, ${fullName}, NOW(), NOW())
        RETURNING id, email, full_name, last_login_at
      `;
      const user = userResult[0];

      const checkingAccountNumber = await generateUniqueAccountNumber();
      const savingsAccountNumber = await generateUniqueAccountNumber();

      await sql`
        INSERT INTO accounts (user_id, account_type, balance, account_number)
        VALUES
          (${user.id}, 'checking', 5000.00, ${checkingAccountNumber}),
          (${user.id}, 'savings', 12500.00, ${savingsAccountNumber})
      `;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message)
          VALUES (${user.id}, 'Welcome to Apex Horizon Bank', ${'Your account has been created successfully, ' + user.full_name + '. Your account number is ' + checkingAccountNumber + '.'})
        `;
      } catch (notifyErr) {
        console.error('Welcome notification insert error (non-fatal):', notifyErr);
      }

      await sendEmail({
        to: user.email,
        subject: 'Welcome to Apex Horizon Bank',
        html: welcomeEmailHtml(user.full_name, checkingAccountNumber),
      });

      // Cleanup: this email's verification record is no longer needed
      await sql`DELETE FROM signup_verifications WHERE email = ${normalizedEmail}`;

      const token = signToken({ userId: user.id, email: user.email });
      setSessionCookie(res, token, true);

      return res.status(201).json({
        user: { id: user.id, email: user.email, fullName: user.full_name, lastLoginAt: user.last_login_at },
        accountNumber: checkingAccountNumber,
      });
    } catch (err) {
      console.error('Create account error:', err);
      return res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "send-code", "verify-code", or "create-account".' });
};
