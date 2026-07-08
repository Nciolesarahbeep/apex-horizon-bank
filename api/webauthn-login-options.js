const { neon } = require('@neondatabase/serverless');
const { generateAuthenticationOptions } = require('@simplewebauthn/server');
const { normalizeEmail } = require('../lib/auth');
const { setChallengeCookie, RP_ID } = require('./webauthn');

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

    if (userRows.length === 0) {
      return res.status(404).json({ error: 'No account found for that email.' });
    }
    const user = userRows[0];

    const creds = await sql`SELECT credential_id FROM webauthn_credentials WHERE user_id = ${user.id}`;
    if (creds.length === 0) {
      return res.status(404).json({ error: 'Face ID is not set up for this account yet.' });
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({
        id: Buffer.from(c.credential_id, 'base64url'),
        type: 'public-key',
      })),
    });

    setChallengeCookie(res, options.challenge, { userId: user.id });

    return res.status(200).json(options);
  } catch (err) {
    console.error('WebAuthn login-options error:', err);
    return res.status(500).json({ error: 'Could not start Face ID sign-in. Please try again.' });
  }
};
