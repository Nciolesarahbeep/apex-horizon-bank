const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// ===== Step 1: request a reset link (was forgot-password.js) =====
async function handleRequestReset(req, res) {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const normalizedEmail = normalizeEmail(email);

  const genericResponse = {
    success: true,
    message: 'If an account exists for that email, a reset link has been sent.',
  };

  const userRows = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;

  // Same response whether or not the account exists — don't let this endpoint
  // be used to check which emails are registered.
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

  const resetLink = `https://apex-horizon-bank-eight.vercel.app/?resetToken=${rawToken}`;

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: normalizedEmail,
        subject: 'Reset Your Apex Horizon Bank Password',
        html: `
          <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
            <h2 style="color: #0f172a; margin-bottom: 5px;">Apex Horizon Bank</h2>
            <p style="color: #334155; font-size: 15px;">We received a request to reset your online banking password.</p>
            <p style="color: #334155; font-size: 15px;">Click the secure link below to configure your new credentials. This link expires in 30 minutes.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Reset Password</a>
            </div>
            <p style="color: #94a3b8; font-size: 12px;">If you didn't request this, you can safely ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend responded with an error:', emailRes.status, errText);
    }
  } catch (emailError) {
    console.error('Failed to send email via Resend:', emailError);
    // Don't fail the whole request just because email delivery failed —
    // the token still exists in the DB and the response stays generic either way.
  }

  return res.status(200).json(genericResponse);
}

// ===== Step 2: consume the token, set new password (was reset-password.js) =====
async function handleConfirmReset(req, res) {
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
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};

    // Dispatch based on payload shape — the two steps never share fields,
    // so no extra "action" parameter is needed and the frontend payloads
    // stay exactly the same as before.
    if (body.token && body.newPassword) {
      return await handleConfirmReset(req, res);
    }
    if (body.email) {
      return await handleRequestReset(req, res);
    }

    return res.status(400).json({ error: 'Request must include either an email, or a token and new password.' });
  } catch (err) {
    console.error('Password reset error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
