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

    // Security Best Practice: If user doesn't exist, don't reveal it. Return generic success.
    if (userRows.length === 0) {
      return res.status(200).json(genericResponse);
    }

    const user = userRows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes expiration

    // 1. Commit token data securely to your Neon database
    await sql`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (${user.id}, ${tokenHash}, ${expiresAt.toISOString()})
    `;

    // 2. Build out the destination URL for your Vercel deployment
    const resetLink = `https://apex-horizon-bank-eight.vercel.app/reset-password.html?token=${rawToken}`;

    // 3. Fire the secure live transaction network request to Resend
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev', // Required sender for Resend Sandbox mode
        to: normalizedEmail,          // Delivers directly to the requested user profile
        subject: 'Reset Your Apex Horizon Bank Password',
        html: `
          <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
            <h2 style="color: #0f172a; margin-bottom: 5px;">Apex Horizon Bank</h2>
            <p style="color: #334155; font-size: 15px;">We received a request to reset your online banking dashboard credentials.</p>
            <p style="color: #334155; font-size: 15px;">Click the secure verification button below to configure your profile changes. This link will expire in 30 minutes.</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500; display: inline-block;">Reset Password</a>
            </div>
            
            <hr style="border: 0; border-top: 1px solid #edf2f7; margin: 20px 0;" />
            <p style="font-size: 12px; color: #64748b; line-height: 1.5;">If you didn't initiate this update request, please log into your account settings tab immediately to freeze your card profiles or contact fraud operations.</p>
          </div>
        `,
      }),
    });

    // 4. Return clean production success status to the client front-end interface
    return res.status(200).json(genericResponse);

  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
