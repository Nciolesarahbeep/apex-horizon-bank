const { neon } = require('@neondatabase/serverless');
const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { signToken, setSessionCookie } = require('../lib/auth');
const { readChallengeCookie, clearChallengeCookie, RP_ID, ORIGIN } = require('./webauthn');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const challengeData = readChallengeCookie(req);
    if (!challengeData) {
      return res.status(400).json({ error: 'Face ID sign-in expired. Please try again.' });
    }

    const { assertionResponse } = req.body || {};
    if (!assertionResponse) {
      return res.status(400).json({ error: 'Missing sign-in response.' });
    }

    const credRows = await sql`
      SELECT id, user_id, credential_id, public_key, counter
      FROM webauthn_credentials
      WHERE credential_id = ${assertionResponse.id}
      LIMIT 1
    `;

    if (credRows.length === 0 || credRows[0].user_id !== challengeData.userId) {
      return res.status(400).json({ error: 'Face ID credential not recognized.' });
    }
    const credRow = credRows[0];

    const verification = await verifyAuthenticationResponse({
      response: assertionResponse,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      authenticator: {
        credentialID: Buffer.from(credRow.credential_id, 'base64url'),
        credentialPublicKey: Buffer.from(credRow.public_key, 'base64url'),
        counter: Number(credRow.counter),
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Face ID verification failed. Please try again.' });
    }

    await sql`
      UPDATE webauthn_credentials SET counter = ${verification.authenticationInfo.newCounter}
      WHERE id = ${credRow.id}
    `;

    const userRows = await sql`SELECT id, email, full_name FROM users WHERE id = ${credRow.user_id} LIMIT 1`;
    if (userRows.length === 0) {
      return res.status(401).json({ error: 'Account not found.' });
    }
    const user = userRows[0];

    const token = signToken({ userId: user.id, email: user.email });
    setSessionCookie(res, token);
    clearChallengeCookie(res);

    return res.status(200).json({
      user: { id: user.id, email: user.email, fullName: user.full_name },
    });
  } catch (err) {
    console.error('WebAuthn login-verify error:', err);
    return res.status(500).json({ error: 'Could not complete Face ID sign-in. Please try again.' });
  }
};
