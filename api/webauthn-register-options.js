const { neon } = require('@neondatabase/serverless');
const { generateRegistrationOptions } = require('@simplewebauthn/server');
const { getUserFromRequest } = require('../lib/auth');
const { setChallengeCookie, RP_NAME, RP_ID } = require('./webauthn');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userRows = await sql`SELECT id, email, full_name FROM users WHERE id = ${session.userId} LIMIT 1`;
    if (userRows.length === 0) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = userRows[0];

    const existingCreds = await sql`SELECT credential_id FROM webauthn_credentials WHERE user_id = ${user.id}`;

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(String(user.id)),
      userName: user.email,
      userDisplayName: user.full_name || user.email,
      attestationType: 'none',
      excludeCredentials: existingCreds.map((c) => ({
        id: Buffer.from(c.credential_id, 'base64url'),
        type: 'public-key',
      })),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
    });

    setChallengeCookie(res, options.challenge, { userId: user.id });

    return res.status(200).json(options);
  } catch (err) {
    console.error('WebAuthn register-options error:', err);
    return res.status(500).json({ error: 'Could not start Face ID setup. Please try again.' });
  }
};
