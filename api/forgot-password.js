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

    // If user doesn't exist in database, stop here
    if (userRows.length === 0) {
      return res.status(400).json({ error: 'No account found for that email.' });
    }

    const user = userRows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    // 1. Save reset token to database
    await sql`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()})
    `;

    const resetLink = `https://apex-horizon-bank-eight.vercel.app/reset-password.html?token=${rawToken}`;

    // 2. Send the real live email via Resend
    try {
      await fetch('https://api.resend.com/emails', {
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
              <p style="color: #334155; font-size: 15px;">Click the secure link below to configure your new credentials.</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Reset Password</a>
              </div>
            </div>
          `,
        }),
      });
    } catch (emailError) {
      console.error('Failed to send email via Resend:', emailError);
      // We continue anyway so the frontend can still simulate the reset if needed during testing
    }

    // 3. Return BOTH success and the demo token to keep your frontend UI happy!
    return res.status(200).json({
      ...genericResponse,
      demoResetToken: rawToken, 
    });

  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
